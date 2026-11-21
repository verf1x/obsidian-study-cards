# Free checks keep a fixed card list and read current Markdown

[Русская версия](#russian)

When a free check starts, the session fixes the card list and order by UUID. Saving a Markdown edit updates the question and reference answer immediately, including on the open card. The user can correct the text during the check and continue from the same position.

## Consequences

A grade already given stays in place until the user changes it explicitly.

When the session resumes, the plugin looks up its saved UUIDs in the sources of the study section. If a card becomes unavailable during the check, its position and any grade remain in the session. If the same UUID becomes available again before the session ends, the card returns to its original position.

[Free check rules (#8)](https://github.com/verf1x/obsidian-study-cards/issues/8) · [Session recovery (#10)](https://github.com/verf1x/obsidian-study-cards/issues/10)

---

<a id="russian"></a>

# Свободная проверка фиксирует состав и читает актуальный Markdown

При запуске свободной проверки сессия фиксирует состав и порядок карточек по UUID. После сохранения правки в Markdown вопрос и эталон сразу обновляются, в том числе в открытой карточке. Так пользователь может исправить текст во время проверки и продолжить с той же позиции.

## Последствия

Ранее выставленная оценка сохраняется до явного изменения пользователем.

При восстановлении сессии карточки заново находятся в источниках учебного раздела по сохранённым UUID. Если карточка становится недоступной во время проверки, её место в сессии и выставленная оценка сохраняются. Если тот же UUID снова доступен до завершения, карточка возвращается на своё место.

[Правила свободной проверки (#8)](https://github.com/verf1x/obsidian-study-cards/issues/8) · [Восстановление сессии (#10)](https://github.com/verf1x/obsidian-study-cards/issues/10)
