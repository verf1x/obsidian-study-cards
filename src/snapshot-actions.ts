// The stored captions are part of the existing snapshot format.
const actions = {
  addSection: ["Добавление учебного раздела", "Study section added"],
  disconnectSource: ["Отключение источника", "Source disconnected"],
  refreshCatalog: ["Обновление каталога", "Catalog refreshed"],
  updateNote: ["Обновление заметки", "Note updated"],
  checkReviewSources: ["Проверка источников интервального повторения", "Spaced repetition sources checked"],
  deleteNote: ["Удаление заметки", "Note deleted"],
  moveSource: ["Перемещение источника", "Source moved"],
  changeMastery: ["Изменение статуса освоения", "Mastery status changed"],
  changeProgress: ["Изменение прогресса карточки", "Card progress changed"],
  gradeReview: ["Интервальная оценка", "Spaced repetition answer graded"],
  undoReview: ["Отмена интервальной оценки", "Spaced repetition grade undone"],
  suspendReviews: ["Приостановка повторений", "Reviews suspended"],
  resumeReviews: ["Возобновление повторений", "Reviews resumed"],
  startFreeCheck: ["Начало свободной проверки", "Free check started"],
  moveFreeCheck: ["Переход к вопросу свободной проверки", "Free check question changed"],
  gradeFreeCheck: ["Оценка ответа свободной проверки", "Free check answer graded"],
  saveFreeCheck: ["Сохранение свободной проверки", "Free check saved"],
  finishFreeCheck: ["Завершение свободной проверки", "Free check finished"],
  discardFreeCheck: ["Отказ от свободной проверки", "Free check discarded"],
  repairUuid: ["Исправление UUID", "UUID repaired"],
  resolveUuidConflict: ["Разрешение конфликта UUID", "UUID conflict resolved"],
  createCard: ["Создание карточки", "Card created"],
  connectSources: ["Подключение источников", "Sources connected"],
  migrateData: ["Миграция данных плагина", "Plugin data migrated"],
  emptyState: ["Пустое состояние", "Empty state"],
  importSnapshot: ["Импорт снимка", "Snapshot imported"],
  chooseVersion: ["Выбор версии", "Version selected"],
  restoreBackup: ["Восстановление копии", "Backup restored"],
  createState: ["Создание состояния", "State created"],
} as const;

const englishCaptions = new Map<string, string>(Object.values(actions));

export function storedAction(action: keyof typeof actions) {
  return actions[action][0];
}

export function englishSnapshotAction(action: string) {
  return englishCaptions.get(action) ?? action;
}
