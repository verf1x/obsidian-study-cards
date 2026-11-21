# Mastery status controls eligibility for spaced repetition

[Русская версия](#russian)

Mastery status and review suspension control whether a card is eligible for spaced repetition. Answer grades determine its schedule and history, which are stored under its permanent UUID. The user can temporarily remove a card from reviews and later resume with its previous progress, even if they changed the status directly in Markdown.

## Consequences

“Studied” and “Mastered” make a card eligible. An eligible card without a schedule is ready for its first review immediately. If its UUID is absent from the current session's fixed card list, the card joins the next session.

The “Unstudied” status and review suspension both exclude a card from reviews. Suspension applies across all its study sections. When the card becomes eligible again, its saved due time still applies. If that time has been reached, the card is ready for review immediately.

The schedule and history belong to the card identified by its UUID. Statistics count each grade in the study section from which the user started the session. Grading a spaced repetition answer preserves the manual mastery status.

[Spaced repetition queue rules (#11)](https://github.com/verf1x/obsidian-study-cards/issues/11) · [Implementation specification (#19)](https://github.com/verf1x/obsidian-study-cards/issues/19) · [Card identity ADR](0002-card-identity-and-progress.md)

---

<a id="russian"></a>

# Статус освоения управляет допуском к интервальному повторению

Статус освоения и приостановка повторений управляют допуском карточки к интервальному повторению. Оценки ответов формируют её расписание и историю по постоянному UUID. Это позволяет временно убрать карточку из повторения и позже продолжить с накопленным прогрессом, даже если статус меняли непосредственно в Markdown.

## Последствия

Статусы «Изучена» и «Выучена» допускают карточку к повторению. Допущенная карточка без расписания сразу готова к первому показу. Если её UUID отсутствует в составе открытой сессии, карточка войдёт в состав при следующем запуске.

При статусе «Не изучена» или приостановке повторений карточка исключается из показа. Приостановка действует во всех учебных разделах карточки. После восстановления допуска действует сохранённый срок. Если он наступил, карточка сразу готова к повторению.

Расписание и история относятся к карточке по UUID. При этом оценка в статистике относится к учебному разделу, из которого запущена сессия. Оценка интервального ответа сохраняет ручной статус освоения.

[Правила очереди интервального повторения (#11)](https://github.com/verf1x/obsidian-study-cards/issues/11) · [Спецификация реализации (#19)](https://github.com/verf1x/obsidian-study-cards/issues/19) · [ADR об идентичности карточки](0002-card-identity-and-progress.md)
