# A Study Cards property enrolls notes from a folder

[Русская версия](#russian)

A study section stores the selected files and folders as sources. Inside a connected folder, the plugin extracts cards from Markdown notes with the `qcards_source: true` property, subject to exclusions for that source. Users can keep questions and ordinary notes in one folder, and the plugin picks up marked files automatically from Obsidian events.

## Consequences

The **Create card** command writes the property immediately along with the selected format. When connecting existing files, the connection screen shows the number of cards and offers an optional preview of their boundaries. The user confirms the connection on that screen, authorizing the plugin to write the properties, assign any missing UUIDs, and assign UUIDs automatically to new cards from that source.

An open connection screen updates when files are created, edited, moved, or deleted. It keeps the user's selection for the remaining notes and recalculates cards only for affected files. If an open editor has unsaved changes, the plugin waits for the latest saved version. On confirmation, the plugin checks within the file write operation that the plan still applies. If the note has changed, the plugin refreshes its card details and asks the user to confirm the updated changes on the same screen.

---

<a id="russian"></a>

# Заметки в папке подключаются по свойству Study Cards

Учебный раздел сохраняет выбранные файлы и папки как источники. В подключённой папке плагин извлекает карточки из Markdown-заметок со свойством `qcards_source: true` с учётом исключений для этого источника. Так пользователь может хранить вопросы и обычные заметки в одной папке, а плагин автоматически подхватывает отмеченные файлы по событиям Obsidian.

## Последствия

Команда «Создать карточку» сразу записывает это свойство вместе с выбранным форматом. При подключении существующих файлов экран подключения показывает количество карточек и позволяет раскрыть предпросмотр их границ. Пользователь подтверждает подключение на том же экране, разрешая записать свойства, выдать недостающие UUID и автоматически выдавать UUID новым карточкам этого источника.

Открытый экран подключения обновляется по событиям создания, изменения, перемещения и удаления файлов. Он сохраняет выбор пользователя для оставшихся заметок и пересчитывает карточки только у затронутых файлов. Если открытый редактор содержит несохранённые правки, плагин дожидается актуальной сохранённой версии. При подтверждении плагин проверяет актуальность плана внутри операции записи файла. Если заметка успела измениться, он обновляет сведения о её карточках и запрашивает подтверждение актуальных правок на том же экране.
