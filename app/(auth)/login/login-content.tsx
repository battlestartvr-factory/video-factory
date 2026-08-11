"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { t } from "@/lib/i18n/dictionary";
import { isSupabaseConfigured } from "@/lib/env/env.client";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const configError = searchParams.get("error") === "config";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (!isSupabaseConfigured()) {
        setError("Supabase не настроен. Заполните переменные окружения.");
        return;
      }
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setError("Неверный email или пароль");
        return;
      }
      const redirect = searchParams.get("redirect") || "/dashboard";
      router.push(redirect);
      router.refresh();
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="gradient-bg flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("auth.login")}</CardTitle>
          <CardDescription>{t("appName")}</CardDescription>
        </CardHeader>
        <CardContent>
          {configError && (
            <div className="mb-4">
              <ErrorState message="Supabase не настроен. См. .env.example и README." />
            </div>
          )}
          {error && (
            <div className="mb-4">
              <ErrorState message={error} />
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("auth.email")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label={t("auth.email")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("auth.password")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label={t("auth.password")}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("common.loading") : t("auth.signIn")}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-zinc-500">
            <Link href="/forgot-password" className="text-amber-400 hover:underline">
              {t("auth.forgotPassword")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
