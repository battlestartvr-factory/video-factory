export const ru = {
  appName: "ИИ-контент-завод",
  demoMode: "Demo mode",
  nav: {
    dashboard: "Дашборд",
    projects: "Проекты",
    assets: "Результаты",
    settings: "Настройки",
    logout: "Выйти",
  },
  auth: {
    login: "Вход",
    email: "Email",
    password: "Пароль",
    signIn: "Войти",
    forgotPassword: "Забыли пароль?",
    resetSent: "Если аккаунт существует, ссылка отправлена на email.",
    sendReset: "Отправить ссылку",
  },
  dashboard: {
    title: "Дашборд",
    activeJobs: "Активные задачи",
    pendingReview: "На согласовании",
    completed: "Завершённые",
    failed: "С ошибками",
    monthlyCost: "Расходы за месяц",
    recentJobs: "Последние задачи",
    createJob: "Создать задачу",
    empty: "Задач пока нет",
  },
  projects: {
    title: "Проекты",
    new: "Новый проект",
    search: "Поиск проектов…",
    empty: "Проектов пока нет",
    members: "Участники",
    sources: "Исходники",
    jobs: "Задачи",
    results: "Результаты",
  },
  jobs: {
    new: "Новая задача",
    type: "Тип задачи",
    source: "Google Drive",
    language: "Язык",
    platform: "Платформа",
    brief: "ТЗ / комментарий",
    mode: "Режим",
    confirm: "Подтвердить",
    accept: "Принять",
    revision: "На доработку",
    retry: "Повторить",
    cancel: "Отменить",
    timeline: "История",
    progress: "Прогресс",
    cost: "Стоимость",
  },
  assets: {
    title: "Результаты",
    empty: "Результатов пока нет",
    copyLink: "Копировать ссылку",
    openDrive: "Открыть в Drive",
  },
  settings: {
    title: "Настройки",
    profile: "Профиль",
    integrations: "Интеграции",
    connected: "Подключено",
    notConfigured: "Не настроено",
  },
  common: {
    loading: "Загрузка…",
    error: "Произошла ошибка",
    save: "Сохранить",
    back: "Назад",
    next: "Далее",
  },
  status: {
    queued: "В очереди",
    processing: "Обработка",
    review: "На согласовании",
    completed: "Завершена",
    failed: "Ошибка",
    cancelled: "Отменена",
    draft: "Черновик",
  },
} as const;

export type Dictionary = typeof ru;

let currentDict: Dictionary = ru;

export function setDictionary(dict: Dictionary) {
  currentDict = dict;
}

export function t(key: string): string {
  const parts = key.split(".");
  let value: unknown = currentDict;
  for (const part of parts) {
    if (value && typeof value === "object" && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  return typeof value === "string" ? value : key;
}
