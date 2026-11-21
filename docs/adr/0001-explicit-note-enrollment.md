# A Study Cards property enrolls notes from a folder

[Русская версия](#russian)

A study section stores the selected files and folders as sources. Inside a connected folder, the plugin extracts cards from Markdown notes with the `qcards_source: true` property, subject to exclusions for that source. Users can keep questions and ordinary notes in one folder, and the plugin picks up marked files automatically from Obsidian events.

## Consequences

The **Create card** command writes the property immediately along with the selected format. When connecting existing files, the user checks the selection, the number of cards, and their boundaries in the preview, then confirms writing the properties and any missing UUIDs. Confirmation also allows the plugin to assign UUIDs automatically to new cards from that source.

An open preview updates when files are created, edited, moved, or deleted. It keeps the user's selection for the remaining notes and recalculates cards only for affected files. If an open editor has unsaved changes, the plugin waits for the latest saved version. On confirmation, the plugin checks within the file write operation that the plan still applies. If the note has changed, the plugin refreshes its preview and asks the user to confirm the updated changes.

---

<a id="russian"></a>

# Заметки в папке подключаются по свойству Study Cards

Учебный раздел сохраняет выбранные файлы и папки как источники. В подключённой папке плагин извлекает карточки из Markdown-заметок со свойством `qcards_source: true` с учётом исключений для этого источника. Так пользователь может хранить вопросы и обычные заметки в одной папке, а плагин автоматически подхватывает отмеченные файлы по событиям Obsidian.

## Последствия

Команда «Создать карточку» сразу записывает это свойство вместе с выбранным форматом. При подключении существующих файлов пользователь проверяет выбор, количество и границы карточек в предпросмотре, затем подтверждает запись свойств и недостающих UUID. Подтверждение также разрешает автоматическую выдачу UUID новым карточкам этого источника.

Открытый предпросмотр обновляется по событиям создания, изменения, перемещения и удаления файлов. Он сохраняет выбор пользователя для оставшихся заметок и пересчитывает карточки только у затронутых файлов. Если открытый редактор содержит несохранённые правки, плагин дожидается актуальной сохранённой версии. При подтверждении плагин проверяет актуальность плана внутри операции записи файла. Если заметка успела измениться, он обновляет предпросмотр для неё и запрашивает подтверждение актуальных правок.
