export const getCodexTurnId = (turn) => {
  if (!turn || typeof turn !== "object") return "";
  return String(turn.id || turn.turnId || turn.turn_id || "").trim();
};

const firstArray = (...values) => values.find((value) => Array.isArray(value)) || [];

export const normalizeCodexTurns = (result) => {
  if (!result || typeof result !== "object") return [];
  const turns = firstArray(
    Array.isArray(result) ? result : undefined,
    result.turns,
    result.items,
    result.data,
    result.thread?.turns,
    result.thread?.items,
    result.response?.turns,
    result.response?.data
  );

  return turns.filter((turn) => getCodexTurnId(turn));
};

export const getRollbackTurnCountForTarget = (turns, targetTurnId) => {
  const normalizedTargetTurnId = String(targetTurnId || "").trim();
  if (!normalizedTargetTurnId || !Array.isArray(turns)) return null;
  const targetIndex = turns.findIndex((turn) => getCodexTurnId(turn) === normalizedTargetTurnId);
  if (targetIndex < 0) return null;
  return Math.max(0, turns.length - targetIndex - 1);
};

export const getRollbackTurnCountForIndex = (turns, targetTurnIndex) => {
  if (!Array.isArray(turns) || !Number.isInteger(targetTurnIndex)) return null;
  if (targetTurnIndex < 0 || targetTurnIndex >= turns.length) return null;
  return Math.max(0, turns.length - targetTurnIndex - 1);
};
