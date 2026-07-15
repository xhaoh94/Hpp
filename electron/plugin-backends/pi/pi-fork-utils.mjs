const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

export const getPiMessageText = (message) => {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part) || part.type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("");
};

const getMessageRole = (entry) => isRecord(entry) && entry.type === "message" && isRecord(entry.message)
  ? entry.message.role
  : undefined;

const findCompletedTurnLeaf = (entries, userEntryIndex) => {
  let nextUserIndex = entries.length;
  for (let index = userEntryIndex + 1; index < entries.length; index += 1) {
    if (getMessageRole(entries[index]) === "user") {
      nextUserIndex = index;
      break;
    }
  }
  for (let index = nextUserIndex - 1; index > userEntryIndex; index -= 1) {
    if (getMessageRole(entries[index]) === "assistant" && typeof entries[index].id === "string") {
      return entries[index].id;
    }
  }
  return undefined;
};

export const resolvePiForkEntryId = (entries, command) => {
  if (!Array.isArray(entries)) return undefined;
  const targetTurnId = normalizeText(command?.targetTurnId);
  if (targetTurnId && entries.some((entry) => isRecord(entry) && entry.id === targetTurnId)) {
    return targetTurnId;
  }

  const userEntries = entries.flatMap((entry, entryIndex) => (
    getMessageRole(entry) === "user" ? [{ entry, entryIndex }] : []
  ));
  const sourceUserMessageIndex = Number(command?.sourceUserMessageIndex);
  const indexedUser = Number.isInteger(sourceUserMessageIndex) && sourceUserMessageIndex >= 0
    ? userEntries[sourceUserMessageIndex]
    : undefined;
  const sourceText = normalizeText(command?.sourceMessageContent);

  if (sourceText && indexedUser) {
    const nextUser = userEntries[sourceUserMessageIndex + 1];
    const segmentEnd = nextUser?.entryIndex ?? entries.length;
    for (let index = indexedUser.entryIndex; index < segmentEnd; index += 1) {
      const entry = entries[index];
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      if (normalizeText(getPiMessageText(entry.message)) !== sourceText) continue;
      if (entry.message.role === "assistant" && typeof entry.id === "string") return entry.id;
      if (entry.message.role === "user") return findCompletedTurnLeaf(entries, indexedUser.entryIndex);
    }
  }

  if (sourceText) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      if (normalizeText(getPiMessageText(entry.message)) === sourceText && typeof entry.id === "string") {
        return entry.message.role === "user" ? findCompletedTurnLeaf(entries, index) : entry.id;
      }
    }
  }

  return indexedUser ? findCompletedTurnLeaf(entries, indexedUser.entryIndex) : undefined;
};
