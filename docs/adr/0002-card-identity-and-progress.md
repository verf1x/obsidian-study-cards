# A card's UUID determines its history and schedule

[Русская версия](#russian)

A card can belong to several study sections, and its note can be renamed or moved. History and schedule are tied to a permanent random UUID in the source Markdown. This lets the card retain shared progress through these changes and when its source is connected again.

## Consequences

A single-card note stores its UUID in the `qcards_id` property. A question in a collection stores it in the metadata comment `<!-- qcards:id=… -->`. If a card leaves the connected sources, the plugin removes it from the catalog and keeps its progress for when the source is connected again.

When separate cards have the same UUID, the plugin shows the conflict and asks which card should keep the progress. The user can assign a new UUID to the other card or confirm moving a separate file to the trash. In a collection, the decision applies to the selected question. If a known card's UUID is invalid or missing, the plugin shows an error and offers a **Create new ID** action. Progress stays with the old UUID and becomes available again if that UUID is restored.

---

<a id="russian"></a>

# UUID карточки определяет её историю и расписание

Карточка может входить в несколько учебных разделов, а её заметку можно переименовать или переместить. История и расписание привязаны к случайному постоянному UUID в исходном Markdown, чтобы одна карточка сохраняла общий прогресс при этих действиях и при повторном подключении.

## Последствия

Заметка-карточка хранит UUID в свойстве `qcards_id`, а вопрос в коллекции — в служебном комментарии `<!-- qcards:id=… -->`. Если карточка перестаёт входить в подключённые источники, плагин убирает её из каталога и сохраняет прогресс для повторного подключения.

При совпадении UUID у разных карточек плагин показывает конфликт и предлагает выбрать, у какой карточки сохранить прогресс. Другой карточке можно выдать новый UUID. Для отдельного файла можно подтвердить перемещение в корзину. В коллекции решение применяется к выбранному вопросу. Если UUID невалиден или пропал у известной карточки, плагин показывает ошибку с действием «Создать новый ID». Прогресс остаётся привязан к прежнему UUID и вновь доступен при его восстановлении.
