import axios from 'axios';

function extractMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;

  const { message, error } = value as {
    message?: unknown;
    error?: unknown;
  };

  if (typeof message === 'string' && message.trim()) return message;
  if (typeof error === 'string' && error.trim()) return error;

  if (error && typeof error === 'object') {
    const nestedMessage = (error as { message?: unknown }).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage;
    }
  }

  return null;
}

function safeStringify(value: unknown): string | null {
  if (value === undefined) return null;
  // Never serialize streams or buffers — they produce unreadable binary blobs
  if (
    value !== null &&
    typeof value === 'object' &&
    (Buffer.isBuffer(value) || typeof (value as { pipe?: unknown }).pipe === 'function')
  ) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function formatUpstreamErrorMessage(err: unknown): string {
  if (!axios.isAxiosError(err)) return String(err);

  const responseData = err.response?.data;

  // Streams and Buffers — don't serialize them; use axios's own message
  if (
    responseData !== null &&
    typeof responseData === 'object' &&
    !Array.isArray(responseData) &&
    (Buffer.isBuffer(responseData) || typeof (responseData as { pipe?: unknown }).pipe === 'function')
  ) {
    return err.message;
  }

  if (typeof responseData === 'string' && responseData.trim()) {
    return responseData;
  }

  const extractedMessage = extractMessage(responseData);
  if (extractedMessage) return extractedMessage;

  const serialized = safeStringify(responseData);
  if (serialized) return serialized;

  return err.message;
}