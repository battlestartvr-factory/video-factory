import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;
const SOCIAL_WIDTH = 1080;
const SOCIAL_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const MAX_CLIP_SECONDS = 5;
const PROCESS_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_DATA_ROOT = "/srv/ai-factory";
const STAGING_FOLDER = "discovery-assembly-staging";

export interface GameplayPrototypeMediaArtifact {
  driveFileId: string;
  driveWebUrl: string | null;
  filename: string;
  mimeType: "video/mp4";
  sizeBytes: number;
  sha256: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  archivedAt: string;
}

export interface GameplayPrototypeAssembly extends GameplayPrototypeMediaArtifact {
  schema: "gameplay_short_assembly";
  version: 1;
  rootCreativeRunId: string;
  conceptRunId: string;
  conceptId: string;
  inputVideoGenerationIds: string[];
  audioIncluded: false;
  landscapeMaster: GameplayPrototypeMediaArtifact;
  assemblyPolicy: {
    engine: "ffmpeg";
    width: 1080;
    height: 1920;
    sourceWidth: 1920;
    sourceHeight: 1080;
    fps: 30;
    maxClipSeconds: 5;
    videoCodec: "libx264";
    pixelFormat: "yuv420p";
    audio: false;
    verticalization: "full_landscape_frame_over_blurred_background";
    gameplayCrop: false;
  };
}

export interface GameDiscoveryAssemblyRuntime {
  assembleConceptPrototype(input: {
    rootCreativeRunId: string;
    conceptRunId: string;
    conceptId: string;
    videoGenerationIds: string[];
    signal?: AbortSignal;
  }): Promise<GameplayPrototypeAssembly>;
}

interface ProbePayload {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
  }>;
  format?: {
    duration?: string;
    size?: string;
  };
}

interface VideoDescriptor {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  sizeBytes: number;
}

type AssemblyVariant = "landscape_master" | "vertical_social";

function dataRoot(): string {
  return (process.env.AI_FACTORY_DATA_ROOT ?? DEFAULT_DATA_ROOT).trim() || DEFAULT_DATA_ROOT;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseFps(value: string | undefined): number | null {
  if (!value) return null;
  const [rawNumerator, rawDenominator] = value.split("/", 2);
  const numerator = Number(rawNumerator);
  const denominator = Number(rawDenominator ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: combinedSignal(signal, PROCESS_TIMEOUT_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 100_000) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-8_000)}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function probeVideo(path: string, signal?: AbortSignal): Promise<VideoDescriptor> {
  const stdout = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size",
      "-of",
      "json",
      path,
    ],
    signal,
  );
  const payload = JSON.parse(stdout) as ProbePayload;
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = safeNumber(payload.format?.duration);
  const sizeBytes = safeNumber(payload.format?.size);
  const fps = parseFps(video?.r_frame_rate);
  if (
    !video?.codec_name ||
    typeof video.width !== "number" ||
    typeof video.height !== "number" ||
    !durationSeconds ||
    !sizeBytes ||
    !fps
  ) {
    throw new Error("ASSEMBLY_FFPROBE_INVALID_OUTPUT");
  }
  return {
    durationSeconds,
    width: video.width,
    height: video.height,
    fps,
    videoCodec: video.codec_name,
    sizeBytes,
  };
}

function assertDescriptor(input: {
  descriptor: VideoDescriptor;
  width: number;
  height: number;
  contract: string;
}) {
  if (
    input.descriptor.width !== input.width ||
    input.descriptor.height !== input.height ||
    Math.abs(input.descriptor.fps - OUTPUT_FPS) > 0.05
  ) {
    throw new Error(input.contract);
  }
}

export class GameDiscoveryAssemblyService implements GameDiscoveryAssemblyRuntime {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
  ) {}

  private async downloadGenerationOutput(input: {
    generationId: string;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/api/internal/generation-output/${encodeURIComponent(input.generationId)}/0`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          Accept: "video/*,application/octet-stream",
        },
        cache: "no-store",
        signal: combinedSignal(input.signal, DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`ASSEMBLY_INPUT_DOWNLOAD_FAILED:${input.generationId}:${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(input.outputPath, { flags: "wx" }),
    );
  }

  private async normalizeLandscapeClip(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=${LANDSCAPE_WIDTH}:${LANDSCAPE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${LANDSCAPE_WIDTH}:${LANDSCAPE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${OUTPUT_FPS},setsar=1`,
        "-t",
        String(MAX_CLIP_SECONDS),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      signal,
    );
  }

  private async concatClips(
    segmentPaths: string[],
    outputPath: string,
    workDir: string,
    signal?: AbortSignal,
  ) {
    if (segmentPaths.length === 1) {
      await runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          segmentPaths[0]!,
          "-map",
          "0:v:0",
          "-an",
          "-c",
          "copy",
          "-map_metadata",
          "-1",
          "-movflags",
          "+faststart",
          outputPath,
        ],
        signal,
      );
      return;
    }

    const concatPath = join(workDir, "concat.txt");
    const concat = segmentPaths
      .map((path) => `file '${path.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(concatPath, `${concat}\n`, "utf8");
    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-map",
        "0:v:0",
        "-an",
        "-c",
        "copy",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      signal,
    );
  }

  private async renderVerticalSocial(
    landscapePath: string,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const filter = [
      "[0:v]split=2[bg][fg]",
      `[bg]scale=${SOCIAL_WIDTH}:${SOCIAL_HEIGHT}:force_original_aspect_ratio=increase,crop=${SOCIAL_WIDTH}:${SOCIAL_HEIGHT},boxblur=32:2,eq=brightness=-0.12:saturation=0.78[bgv]`,
      `[fg]scale=${SOCIAL_WIDTH}:-2:force_original_aspect_ratio=decrease[fgv]`,
      `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,fps=${OUTPUT_FPS},setsar=1[outv]`,
    ].join(";");
    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        landscapePath,
        "-filter_complex",
        filter,
        "-map",
        "[outv]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      signal,
    );
  }

  private async archive(input: {
    rootCreativeRunId: string;
    conceptRunId: string;
    conceptId: string;
    variant: AssemblyVariant;
    artifactRelativePath: string;
    inputVideoGenerationIds: string[];
    sha256: string;
    descriptor: VideoDescriptor;
    signal?: AbortSignal;
  }): Promise<{
    driveFileId: string;
    driveWebUrl: string | null;
    filename: string;
    sizeBytes: number;
    archivedAt: string;
  }> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/api/internal/discovery-assembly-archive`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          rootCreativeRunId: input.rootCreativeRunId,
          conceptRunId: input.conceptRunId,
          conceptId: input.conceptId,
          variant: input.variant,
          artifactRelativePath: input.artifactRelativePath,
          inputVideoGenerationIds: input.inputVideoGenerationIds,
          sha256: input.sha256,
          descriptor: input.descriptor,
        }),
        signal: combinedSignal(input.signal, PROCESS_TIMEOUT_MS),
      },
    );
    let payload: {
      ok?: boolean;
      message?: string;
      data?: {
        driveFileId?: string;
        driveWebUrl?: string | null;
        filename?: string;
        sizeBytes?: number;
        archivedAt?: string;
      };
    } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // Preserve the HTTP status below.
    }
    const data = payload.data;
    if (
      !response.ok ||
      payload.ok !== true ||
      !data?.driveFileId ||
      !data.filename ||
      typeof data.sizeBytes !== "number" ||
      !data.archivedAt
    ) {
      throw new Error(payload.message || `ASSEMBLY_ARCHIVE_FAILED:${response.status}`);
    }
    return {
      driveFileId: data.driveFileId,
      driveWebUrl: data.driveWebUrl ?? null,
      filename: data.filename,
      sizeBytes: data.sizeBytes,
      archivedAt: data.archivedAt,
    };
  }

  async assembleConceptPrototype(input: {
    rootCreativeRunId: string;
    conceptRunId: string;
    conceptId: string;
    videoGenerationIds: string[];
    signal?: AbortSignal;
  }): Promise<GameplayPrototypeAssembly> {
    const generationIds = [...new Set(input.videoGenerationIds.filter(Boolean))];
    if (!generationIds.length) throw new Error("ASSEMBLY_VIDEO_GENERATIONS_REQUIRED");

    const root = dataRoot();
    const workId = randomUUID();
    const workDir = join(root, STAGING_FOLDER, input.rootCreativeRunId, input.conceptRunId, workId);
    await mkdir(workDir, { recursive: true });

    try {
      const segmentPaths: string[] = [];
      for (let index = 0; index < generationIds.length; index += 1) {
        const inputPath = join(workDir, `input-${index}.bin`);
        const segmentPath = join(workDir, `landscape-segment-${index}.mp4`);
        await this.downloadGenerationOutput({
          generationId: generationIds[index]!,
          outputPath: inputPath,
          signal: input.signal,
        });
        await this.normalizeLandscapeClip(inputPath, segmentPath, input.signal);
        segmentPaths.push(segmentPath);
      }

      const landscapePath = join(workDir, "gameplay-master-16x9.mp4");
      await this.concatClips(segmentPaths, landscapePath, workDir, input.signal);
      const landscapeDescriptor = await probeVideo(landscapePath, input.signal);
      assertDescriptor({
        descriptor: landscapeDescriptor,
        width: LANDSCAPE_WIDTH,
        height: LANDSCAPE_HEIGHT,
        contract: "ASSEMBLY_LANDSCAPE_CONTRACT_MISMATCH",
      });

      const socialPath = join(workDir, "social-edit-9x16.mp4");
      await this.renderVerticalSocial(landscapePath, socialPath, input.signal);
      const socialDescriptor = await probeVideo(socialPath, input.signal);
      assertDescriptor({
        descriptor: socialDescriptor,
        width: SOCIAL_WIDTH,
        height: SOCIAL_HEIGHT,
        contract: "ASSEMBLY_SOCIAL_CONTRACT_MISMATCH",
      });

      const [landscapeStat, socialStat, landscapeSha256, socialSha256] = await Promise.all([
        stat(landscapePath),
        stat(socialPath),
        sha256File(landscapePath),
        sha256File(socialPath),
      ]);
      const landscapeRelativePath = relative(root, landscapePath);
      const socialRelativePath = relative(root, socialPath);
      if (
        !landscapeRelativePath ||
        landscapeRelativePath.startsWith("..") ||
        !socialRelativePath ||
        socialRelativePath.startsWith("..")
      ) {
        throw new Error("ASSEMBLY_STAGING_PATH_INVALID");
      }

      const [landscapeArchived, socialArchived] = await Promise.all([
        this.archive({
          rootCreativeRunId: input.rootCreativeRunId,
          conceptRunId: input.conceptRunId,
          conceptId: input.conceptId,
          variant: "landscape_master",
          artifactRelativePath: landscapeRelativePath,
          inputVideoGenerationIds: generationIds,
          sha256: landscapeSha256,
          descriptor: { ...landscapeDescriptor, sizeBytes: landscapeStat.size },
          signal: input.signal,
        }),
        this.archive({
          rootCreativeRunId: input.rootCreativeRunId,
          conceptRunId: input.conceptRunId,
          conceptId: input.conceptId,
          variant: "vertical_social",
          artifactRelativePath: socialRelativePath,
          inputVideoGenerationIds: generationIds,
          sha256: socialSha256,
          descriptor: { ...socialDescriptor, sizeBytes: socialStat.size },
          signal: input.signal,
        }),
      ]);

      const landscapeMaster: GameplayPrototypeMediaArtifact = {
        driveFileId: landscapeArchived.driveFileId,
        driveWebUrl: landscapeArchived.driveWebUrl,
        filename: landscapeArchived.filename,
        mimeType: "video/mp4",
        sizeBytes: landscapeArchived.sizeBytes,
        sha256: landscapeSha256,
        durationSeconds: landscapeDescriptor.durationSeconds,
        width: landscapeDescriptor.width,
        height: landscapeDescriptor.height,
        fps: landscapeDescriptor.fps,
        videoCodec: landscapeDescriptor.videoCodec,
        archivedAt: landscapeArchived.archivedAt,
      };

      return {
        schema: "gameplay_short_assembly",
        version: 1,
        rootCreativeRunId: input.rootCreativeRunId,
        conceptRunId: input.conceptRunId,
        conceptId: input.conceptId,
        inputVideoGenerationIds: generationIds,
        driveFileId: socialArchived.driveFileId,
        driveWebUrl: socialArchived.driveWebUrl,
        filename: socialArchived.filename,
        mimeType: "video/mp4",
        sizeBytes: socialArchived.sizeBytes,
        sha256: socialSha256,
        durationSeconds: socialDescriptor.durationSeconds,
        width: socialDescriptor.width,
        height: socialDescriptor.height,
        fps: socialDescriptor.fps,
        videoCodec: socialDescriptor.videoCodec,
        audioIncluded: false,
        landscapeMaster,
        assemblyPolicy: {
          engine: "ffmpeg",
          width: 1080,
          height: 1920,
          sourceWidth: 1920,
          sourceHeight: 1080,
          fps: 30,
          maxClipSeconds: 5,
          videoCodec: "libx264",
          pixelFormat: "yuv420p",
          audio: false,
          verticalization: "full_landscape_frame_over_blurred_background",
          gameplayCrop: false,
        },
        archivedAt: socialArchived.archivedAt,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}