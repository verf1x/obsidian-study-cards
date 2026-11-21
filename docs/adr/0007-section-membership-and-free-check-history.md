# Connected sources define section membership

[Русская версия](#russian)

Every connected source contributes all its cards to the study section. The mode's existing eligibility rules apply. Learners narrow a free check in its setup. This replaces the saved per-source question subsets from [#46](https://github.com/verf1x/obsidian-study-cards/issues/46), including empty subsets. A section is a collection of sources, with question selection available when starting a check.

The last manual selection belongs to the study section in shared state and travels with vault data and snapshots under [ADR 0006](0006-shared-study-state.md). Save the card UUIDs in the same shared-state update that starts the manual check. This lets a learner reopen the same selection on another device while keeping a cancelled setup local to the open pane.

Deleting a section removes its source connections and last manual selection. The same update discards that section's unfinished free check if the learner confirms deletion. The vault's Markdown, UUID-based progress and schedules, and completed free check results are retained. A result from a deleted section stays readable in the global history. A mistake retry requires the original section to exist.

[Design and acceptance scenarios](../design/00044-ux-follow-up.md)

---

<a id="russian"></a>

# Состав раздела определяют подключённые источники

Каждый подключённый источник добавляет в учебный раздел все свои карточки. Действуют существующие правила допуска выбранного режима. Ученик сужает состав свободной проверки при её настройке. Это решение заменяет сохранённые подборки вопросов по источникам из [#46](https://github.com/verf1x/obsidian-study-cards/issues/46), включая пустые. В разделе хранятся подключения источников, а отдельные вопросы выбираются при запуске проверки.

Последний ручной набор принадлежит учебному разделу в общем состоянии и переносится вместе с данными vault и снимками по [ADR 0006](0006-shared-study-state.md). UUID карточек сохраняются в той же записи общего состояния, что и запуск ручной проверки. Ученик может восстановить набор на другом устройстве, а отменённая настройка остаётся в пределах открытой панели.

Удаление раздела убирает его подключения и последний ручной набор. При подтверждении та же запись сбрасывает незавершённую свободную проверку этого раздела, если она есть. Markdown, прогресс и расписания по UUID, а также завершённые результаты сохраняются. Результат удалённого раздела доступен для просмотра в общей истории. Для повтора ошибок нужен исходный раздел.

[Дизайн и сценарии приёмки](../design/00044-ux-follow-up.md)
