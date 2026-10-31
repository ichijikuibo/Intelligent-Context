import { enMessages, type MessageCatalog } from './locales/en';
import { esMessages } from './locales/es';
import { gaMessages } from './locales/ga';

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Espanol' },
  { code: 'ga', label: 'Gaeilge' },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

export const MESSAGES: Record<Locale, MessageCatalog> = {
  en: enMessages,
  es: esMessages,
  ga: gaMessages,
};