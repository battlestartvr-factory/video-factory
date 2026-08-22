import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const publicPaths = [
  "/login",
  "/forgot-password",
  "/api/health",
  "/api/webhooks",
];

function isInternalApiPath(pathname: string): boolean {
  return pathname === "/api/internal" || pathname.startsWith("/api/internal/");
}

function internalApiToken(): string | undefined {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRole) return serviceRole;
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  return secretKey || undefined;
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function verifyInternalBearerToken(
  authorizationHeader: string | null,
  expectedToken: string | undefined,
): Promise<boolean> {
  if (!expectedToken || !authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const received = match?.[1]?.trim();
  if (!received) return false;

  const [receivedDigest, expectedDigest] = await Promise.all([
    sha256(received),
    sha256(expectedToken),
  ]);
  let different = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    different |= receivedDigest[index] ^ expectedDigest[index];
  }
  return different === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Internal worker/service endpoints are never public. Keep route-local checks as
  // defense in depth, but enforce this prefix centrally so a newly added route cannot
  // accidentally ship without authentication.
  if (isInternalApiPath(pathname)) {
    const authorized = await verifyInternalBearerToken(
      request.headers.get("authorization"),
      internalApiToken(),
    );
    if (!authorized) {
      return NextResponse.json(
        { ok: false, code: "UNAUTHORIZED" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.next();
  }

  if (publicPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL("/login?error=config", request.url));
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/forgot-password")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|references|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
