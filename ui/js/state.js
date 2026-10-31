// ── Global constants, state and persisted settings helpers ────────────────

const API = '';
const DEFAULT_LOCALE = 'en';
const SELECTED_PROJECT_STORAGE_KEY = 'ic.selectedProject';
const SETTINGS_MODEL_STORAGE_KEY = 'ic.settings.models';
const PERSISTED_MODEL_SETTING_KEYS = new Set(['contextSelectorModel', 'summarizerModel', 'analyzerModel', 'learningModel', 'gathererModel', 'icToolsModel']);

let state = {
  projects: [],
  selectedProject: null,
  health: null,
  currentUser: null,
  needsSetup: false,
  setupStatus: null,
  setupCompletion: null,
  needsBootstrap: false,
  generatedApiKey: null,
  locale: DEFAULT_LOCALE,
  defaultLocale: DEFAULT_LOCALE,
  locales: [],
  messages: {},
  chunksData: [],
  filesData: [],
  findingsData: [],
  statsData: [],
};

function readStorageValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key, value) {
  try {
    if (value == null || value === '') {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

function getStoredSelectedProject() {
  return readStorageValue(SELECTED_PROJECT_STORAGE_KEY);
}

function storeSelectedProject(projectId) {
  writeStorageValue(SELECTED_PROJECT_STORAGE_KEY, projectId || null);
}

function getStoredSettingsModels() {
  const raw = readStorageValue(SETTINGS_MODEL_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function storeSettingsModel(settingKey, value) {
  const models = getStoredSettingsModels();
  if (value) {
    models[settingKey] = value;
  } else {
    delete models[settingKey];
  }

  try {
    localStorage.setItem(SETTINGS_MODEL_STORAGE_KEY, JSON.stringify(models));
  } catch {
    // Ignore storage failures and continue with server persistence.
  }
}

function normalizeAvailableModelOptions(availableModels, availableModelOptions) {
  if (Array.isArray(availableModelOptions) && availableModelOptions.length > 0) {
    return availableModelOptions
      .filter((option) => option && typeof option.value === 'string' && option.value.length > 0)
      .map((option) => ({
        value: option.value,
        label: typeof option.label === 'string' && option.label.length > 0 ? option.label : option.value,
        model: typeof option.model === 'string' && option.model.length > 0 ? option.model : option.value,
      }));
  }

  return (Array.isArray(availableModels) ? availableModels : [])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => ({ value, label: value, model: value }));
}

function resolveAvailableModelValue(selectedValue, availableModelOptions) {
  const value = String(selectedValue || '').trim();
  if (!value) return '';

  const directMatch = availableModelOptions.find((option) => option.value === value);
  if (directMatch) {
    return directMatch.value;
  }

  const legacyMatch = availableModelOptions.find((option) => option.model === value);
  return legacyMatch?.value || '';
}

function getPersistedSettingsModel(settingKey, fallbackValue, availableModelOptions) {
  const storedValue = getStoredSettingsModels()[settingKey];
  const storedMatch = resolveAvailableModelValue(storedValue, availableModelOptions);
  if (storedMatch) {
    return storedMatch;
  }

  const fallbackMatch = resolveAvailableModelValue(fallbackValue, availableModelOptions);
  return fallbackMatch || '';
}
