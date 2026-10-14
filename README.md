# Redshift Launcher

Лаунчер Minecraft на Electron.

- **Ely.by** (authlib-injector, 2FA) и оффлайн-аккаунты
- **Все версии** Minecraft: release / snapshot / old_beta / old_alpha
- Загрузчики: **Vanilla, Fabric, Quilt, Forge, NeoForge** (ставятся автоматически)
- **Моды, ресурспаки, шейдеры** из Modrinth и CurseForge (с зависимостями для Modrinth)
- **Модпаки**: каталог Modrinth и CurseForge, импорт из файла (.mrpack / CurseForge .zip), экспорт сборки в .mrpack
- **3D-просмотр скина** и загрузка своего скина для оффлайн-аккаунта (локальный сервер скинов + authlib-injector)
- **Оптимизация FPS**: профили JVM (G1 / максимум / слабый ПК), быстрые настройки видео, кнопка «Оптимизировать FPS» ставит Sodium/Embeddium, Lithium, FerriteCore, ModernFix и др.
- Настройки: память, размер окна, полноэкранный режим, поведение лаунчера, свои аргументы JVM, путь к Java, темы, анимации
- Java скачивается автоматически (Adoptium) под версию игры

## Как получить установщик .exe

### На своём ПК с Windows
1. Установите Node.js LTS: https://nodejs.org
2. Запустите `build.bat`
3. Установщик: `dist\RedshiftLauncher-Setup-1.0.0.exe`

Запуск без установки: `npm install`, затем `npm start`.

### Через GitHub
Загрузите ВСЕ файлы проекта в репозиторий (включая папку `.github`) и запустите workflow **Build Windows installer** во вкладке Actions. Готовый .exe будет в artifacts.

## CurseForge
Нужен бесплатный API-ключ: https://console.curseforge.com — вставьте его в Настройки → Основные. Некоторые авторы запрещают скачивание вне сайта, такие файлы лаунчер пропустит и покажет предупреждение.

## REDSHIFT ID (общий аккаунт с сайтом, Supabase)

Лаунчер использует **тот же Supabase-проект, что и сайт**: `https://hkyuclomrgnochqslqlp.supabase.co`. Регистрация — на сайте, в лаунчере только вход.

**Что нужно настроить:**
1. **Publishable Key** (Supabase → Project Settings → API Keys → *Publishable* / `anon`). Вставьте его одним из способов:
   - Настройки → Основные → «Publishable Key»; или
   - скопируйте `redshift.config.example.json` в `redshift.config.json` и впишите ключ (файл попадёт в установщик); или
   - переменная окружения `REDSHIFT_SUPABASE_KEY`.
   Секретные ключи (`sb_secret_…`, `service_role`) лаунчер **отвергает**. В исходниках ключей нет.
2. **Таблица `public.profiles`**: `id` (= `auth.users.id`), `username`, `skin_path`, `updated_at`. Если у вас другая схема — нужны правки в `src/supabase.js`.
3. **Bucket `skins`** и путь файла `skin_path`. По умолчанию лаунчер пишет в `<user id>/skin.png`; если на сайте другой путь, он берёт тот, что записан в `profiles.skin_path`. Менять `skinPathTemplate` можно в `redshift.config.json`.
4. **RLS** (проверьте на стороне Supabase, лаунчер её не обходит):
   - `profiles`: SELECT / UPDATE / INSERT только при `id = auth.uid()`;
   - `storage.objects` для bucket `skins`: запись и чтение только в папку `(storage.foldername(name))[1] = auth.uid()::text`;
   - если bucket публичный, чтение работает и без SELECT-политики.
5. Подтверждение email включено на стороне проекта (Authentication → Providers → Email); пока почта не подтверждена, вход вернёт понятное сообщение.

Сессия хранится в зашифрованном виде через системное хранилище (Windows DPAPI / Keychain / libsecret). Если шифрование недоступно, на диск ничего не пишется — после перезапуска потребуется войти снова.

> **Скин в игре.** Загрузка PNG в Supabase сама по себе не делает скин видимым другим игрокам. Лаунчер показывает скин REDSHIFT **только вам** (локальный сервер скинов + authlib-injector). Для показа всем на серверах нужна серверная поддержка (плагин / skin-сервер) — она не реализована.

## Лицензионные аккаунты Microsoft
Вход по коду (device code): лаунчер показывает код, вы вводите его на странице Microsoft. Пароль в лаунчер не вводится. Нужно:
1. Зарегистрировать приложение в Azure (Microsoft Entra ID) → *Authentication* → включить **Allow public client flows**; тип аккаунтов — личные (*consumers*).
2. Получить одобрение Mojang на использование Minecraft API для этого приложения: https://aka.ms/AppRegInfo (без него вход вернёт 403).
3. Вписать **Application (client) ID** в Настройки → Основные → «Microsoft Client ID».
У аккаунта должна быть лицензия Minecraft: Java Edition (иначе лаунчер покажет сообщение).

## Тесты
`npm test` — 31 тест на локальных мок-серверах Supabase и Microsoft: вход, ошибки, восстановление и обновление сессии, выход (в т.ч. офлайн), профиль, загрузка и скачивание скина, защита от записи в чужую папку, цепочка Xbox → XSTS → Minecraft. Тесты **не** обращаются к настоящему Supabase и Microsoft и не проверяют ваши RLS-политики.

## Ограничения
- Свой скин для оффлайн-аккаунта виден только вам (так устроен оффлайн-режим).
- Экспорт модпака кладёт моды внутрь файла (overrides), поэтому он большой, но работает без интернета.
- Код проверен тестами логики и отрисовкой интерфейса, но целиком в Electron на Windows не запускался — при первом запуске возможны мелкие недочёты.
