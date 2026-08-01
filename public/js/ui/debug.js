const DEBUG_PREFIX = 'starship:debug:';

export function isDebugEnabled(scope) {
  try {
    return localStorage.getItem(`${DEBUG_PREFIX}${scope}`) === '1';
  } catch {
    return false;
  }
}

export function debugLog(scope, ...args) {
  if (isDebugEnabled(scope)) console.debug(...args);
}
