# Study Cards keeps shared state in one vault file

[Русская версия](#russian)

A user can start studying on a computer and continue on a phone after syncing. Study Cards keeps study sections, sources, history, schedules, review suspensions, and one unfinished free check session in a versioned file at `Study Cards/data.json` inside the vault. The file is available across devices with different Obsidian settings profiles and can be transferred by a vault sync service.

## Consequences

- The plugin saves a spaced repetition grade together with the new schedule. Confirming a free check result also removes the unfinished session. Retrying an interrupted write saves each grade or result once. A new spaced repetition session builds its queue from the saved review due times.
- The plugin applies external updates without a restart. It rejects a grade submitted from an outdated view and refreshes the card so the user can grade it again if it is still available. If versions diverge, the plugin preserves the available copies and suspends writes until the user chooses a version. That choice updates the shared file. Working offline on multiple devices can cause the versions to diverge, and the available choices depend on which copies the devices retained.
- The last open study section and recovery backups stay on the device. If the shared file is missing or damaged, the plugin opens a valid local backup for viewing. Replacing the shared file from a local backup or from an import requires confirmation.
- Export packages the shared state into a single JSON snapshot. Users transfer Markdown separately. Reconnecting a source restores card progress and positions through the existing UUIDs. The plugin saves a local backup before importing or migrating a known older format, including existing plugin data. If old local data and the shared file diverge, the user chooses a version. Opening a format newer than the plugin supports blocks writes.

[Decision #10](https://github.com/verf1x/obsidian-study-cards/issues/10) · [Specification #23](https://github.com/verf1x/obsidian-study-cards/issues/23) · [Card identity](0002-card-identity-and-progress.md) · [Live Markdown in free checks](0004-live-markdown-in-free-checks.md)

---

<a id="russian"></a>

# Study Cards хранит общее состояние в одном файле vault

Пользователь может начать занятие на компьютере и продолжить на телефоне после синхронизации. Study Cards хранит учебные разделы, источники, историю, расписание, приостановки повторений и одну незавершённую сессию свободной проверки в версионированном файле `Study Cards/data.json` внутри vault. Обычный файл доступен устройствам с разными профилями настроек Obsidian и переносится сервисом синхронизации vault.

## Последствия

- Оценка интервального ответа сохраняется вместе с новым расписанием. Подтверждение результата свободной проверки одновременно убирает незавершённую сессию. Повтор прерванной записи сохраняет каждую оценку или результат однократно. Новая интервальная сессия строит очередь по сохранённым срокам.
- Внешние обновления применяются без перезапуска. Плагин отклоняет оценку на устаревшем экране и обновляет карточку, чтобы пользователь мог оценить её заново, если она всё ещё доступна. Если версии разошлись, плагин сохраняет доступные копии и приостанавливает запись до выбора версии пользователем. Выбор обновляет общий файл. Одновременная работа офлайн может привести к расхождению, а доступность обеих версий зависит от того, какие копии сохранились на устройствах.
- Последний открытый раздел и служебные копии для восстановления остаются на устройстве. Если общий файл исчез или повредился, плагин открывает исправную локальную копию для просмотра. Замена общего файла локальной копией или импортом требует подтверждения.
- Экспорт переносит общее состояние одним JSON-снимком. Markdown переносится отдельно. После переподключения источника прежние UUID возвращают прогресс и позиции карточек. Перед импортом или миграцией известного старого формата, включая существующие данные плагина, сохраняется локальная копия. Если старые локальные данные и общий файл разошлись, пользователь выбирает версию. При открытии формата новее поддерживаемого плагин блокирует запись.

[Решение #10](https://github.com/verf1x/obsidian-study-cards/issues/10) · [Спецификация #23](https://github.com/verf1x/obsidian-study-cards/issues/23) · [Идентичность карточек](0002-card-identity-and-progress.md) · [Обновление Markdown в свободной проверке](0004-live-markdown-in-free-checks.md)
