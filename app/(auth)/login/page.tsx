import { Suspense } from "react";
import LoginPage from "./login-content";

export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div className="gradient-bg flex min-h-dvh items-center justify-center">Загрузка…</div>}>
      <LoginPage />
    </Suspense>
  );
}
