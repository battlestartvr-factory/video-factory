"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { t } from "@/lib/i18n/dictionary";

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, defaultLanguage: "ru", targetPlatforms: [] }),
    });

    const json = await res.json();
    if (!json.ok) {
      setError(json.error?.message ?? t("common.error"));
      setLoading(false);
      return;
    }

    router.push(`/projects/${json.data.id}`);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">{t("projects.new")}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t("projects.new")}</CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4">
              <ErrorState message={error} />
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Название</Label>
              <Input id="name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Описание</Label>
              <Textarea id="description" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? t("common.loading") : t("common.save")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
