/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Token counting prefers API-reported usage (captured from generate responses)
 * and falls back to SillyTavern's native tokenizer when the provider reports
 * no usage:
 * - getTokenCountAsync() for async token counting
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getFriendlyTokenizerName } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getGeneratingModel } from '../../../../script.js';
import { migrateUsageV1, deserializeUsage, serializeUsage, buildUsageCsv, createEmptyRuntime } from './storage.js';

const extensionName = 'token-usage-tracker';

const defaultSettings = {
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Accumulated usage data (persisted in compact v3 form via storage.js; byDay/byModel
    // live only in the expanded runtime copy)
    usage: {
        session: { input: 0, output: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
    },
};

/** Expanded usage data rebuilt from the compact stored form on load */
let usageRuntime = null;

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[extensionName];
    if (!settings.modelColors) settings.modelColors = {};

    // Usage is stored in compact v3 form; migrate older layouts once, then expand
    // into the runtime copy. Migration also drops the dead legacy buckets
    // (byHour/byWeek/byMonth/byChat), which current code never writes or displays.
    if (!settings.usage || settings.usage.v !== 3) {
        settings.usage = migrateUsageV1(settings.usage || {});
        console.log('[Token Usage Tracker] Migrated usage data to compact v3 storage format');
    }
    usageRuntime = deserializeUsage(settings.usage);

    // Initialize session start time
    if (!usageRuntime.session.startTime) {
        usageRuntime.session.startTime = new Date().toISOString();
    }

    return settings;
}

/**
 * Write the compact form of the runtime usage data back into extension settings
 */
function persistUsage() {
    const settings = getSettings();
    settings.usage = serializeUsage(usageRuntime);
    saveSettings();
}

/**
 * Save settings with debounce
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get current settings
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * Get the current day key (YYYY-MM-DD)
 */
function getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get the current week key (YYYY-WNN)
 */
function getWeekKey(date = new Date()) {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the current month key (YYYY-MM)
 */
function getMonthKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * Count tokens using SillyTavern's native tokenizer
 * Uses SillyTavern's asynchronous tokenizer API.
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // getTextTokens() performs a synchronous XHR for server tokenizers, which
        // blocks the Generate flow until the tokenizer responds. The async count
        // API uses the same configured tokenizer without freezing the UI.
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / 3.35);
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 * @param {{hasTokenCounts?: boolean}} [apiUsage] - Optional API-reported usage metadata
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null, apiUsage = {}) {
    const usage = usageRuntime;
    const now = new Date();
    const totalTokens = inputTokens + outputTokens;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
    };

    // Session
    addTokens(usage.session);

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, total: 0, messageCount: 0, models: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
        modelData.messageCount = (modelData.messageCount || 0) + 1;
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    persistUsage();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    const countSource = apiUsage?.hasTokenCounts ? 'reported by API' : `counted with ${getFriendlyTokenizerName(main_api).tokenizerName}`;
    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'} (${countSource})`);
}

/**
 * Reset session usage
 */
function resetSession() {
    usageRuntime.session = {
        input: 0,
        output: 0,
        total: 0,
        messageCount: 0,
        startTime: new Date().toISOString(),
    };
    persistUsage();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] Session reset');
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    usageRuntime = createEmptyRuntime();
    usageRuntime.session.startTime = new Date().toISOString();
    persistUsage();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Download the full usage history as CSV (one row per day x model)
 */
function exportUsageCsv() {
    const csv = buildUsageCsv(usageRuntime);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `token-usage-${getDayKey()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastr.success('Usage CSV downloaded');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const usage = usageRuntime;
    const now = new Date();
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const thisWeek = { input: 0, output: 0, total: 0, messageCount: 0 };
    const thisMonth = { input: 0, output: 0, total: 0, messageCount: 0 };

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    for (const [dayKey, data] of Object.entries(usage.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (getWeekKey(date) === currentWeekKey) {
            thisWeek.input += data.input || 0;
            thisWeek.output += data.output || 0;
            thisWeek.total += data.total || 0;
            thisWeek.messageCount += data.messageCount || 0;
        }

        if (getMonthKey(date) === currentMonthKey) {
            thisMonth.input += data.input || 0;
            thisMonth.output += data.output || 0;
            thisMonth.total += data.total || 0;
            thisMonth.messageCount += data.messageCount || 0;
        }
    }

    return {
        session: { ...usage.session },
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0, models: {} },
        thisWeek,
        thisMonth,
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
        byModel: { ...usage.byModel },
    };
}

/**
 * Get usage for a specific time range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object} Aggregated usage for the range
 */
function getUsageForRange(startDate, endDate) {
    const usage = usageRuntime;

    const result = { input: 0, output: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Parses an OpenAI-compatible usage shape (as stored by some ST forks in
 * message.extra.api_usage).
 * @param {any} apiUsage
 * @returns {{input: number, output: number, total: number, hasTokenCounts: true}|null}
 */
function parseApiUsage(apiUsage) {
    if (!apiUsage || typeof apiUsage !== 'object') return null;

    const input = apiUsage.prompt_tokens;
    const output = apiUsage.completion_tokens;
    const total = apiUsage.total_tokens;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
        || typeof output !== 'number' || !Number.isFinite(output) || output < 0
        || typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
        return null;
    }

    return {
        input,
        output,
        total,
        hasTokenCounts: true,
    };
}

// ============================================================
// API-reported usage capture
// ============================================================
//
// SillyTavern's client discards the `usage` objects that providers attach to
// generation responses (OpenAI `usage`, Anthropic `message.usage`/`message_delta`,
// Google `usageMetadata`), so usage data never reaches message metadata in
// vanilla ST. The server does forward responses untouched, though, so we wrap
// `fetch`, tee the response of generate calls, and parse the usage ourselves.

/** Most recently captured usage for the in-flight generation, if the provider reported one */
let capturedStreamUsage = null;
/** Promise that resolves when the active capture reader has consumed its stream */
let captureReaderDone = null;
/** True once window.fetch has been wrapped */
let fetchPatched = false;

const USAGE_ENDPOINTS = [
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
];

/**
 * Wrap window.fetch so responses to generate requests are teed and parsed
 * for usage data. The original response is passed through unmodified.
 */
function installUsageCapture() {
    if (fetchPatched || typeof window.fetch !== 'function') return;

    const originalFetch = window.fetch;
    const patchedFetch = async function (input, init) {
        const response = await originalFetch.call(window, input, init);
        try {
            const url = typeof input === 'string' ? input : (input?.url || '');
            if (response?.ok && response.body && USAGE_ENDPOINTS.some(ep => url.includes(ep))) {
                captureUsageFromResponse(response.clone());
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error capturing usage from response:', e);
        }
        return response;
    };
    patchedFetch._tokenUsagePatched = true;
    window.fetch = patchedFetch;
    fetchPatched = true;
}

/**
 * Read a (cloned) generate response and extract any usage objects.
 * Handles non-streaming JSON bodies and SSE streams.
 * @param {Response} response
 */
function captureUsageFromResponse(response) {
    captureReaderDone = (async () => {
        try {
            const contentType = response.headers?.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await response.json();
                mergeCapturedUsage(extractUsageFromPayload(data));
                return;
            }

            // SSE stream: parse `data:` lines as they arrive
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIdx;
                while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newlineIdx).trim();
                    buffer = buffer.slice(newlineIdx + 1);
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        mergeCapturedUsage(extractUsageFromPayload(JSON.parse(payload)));
                    } catch {
                        // Incomplete/unrelated chunk — ignore
                    }
                }
            }
        } catch {
            // Aborted or unreadable body — keep whatever was captured so far
        }
    })();
}

/**
 * Extract a normalized usage fragment from a response payload chunk.
 * Supports OpenAI-compatible `usage`, Anthropic native events, and Google
 * `usageMetadata`. Anthropic input_tokens excludes cache tokens, so they are
 * folded into the input count there.
 * @param {any} data Parsed JSON chunk or body
 * @returns {{input?: number, output?: number}|null}
 */
function extractUsageFromPayload(data) {
    if (!data || typeof data !== 'object') return null;

    // Anthropic native streaming events
    if (data.type === 'message_start' && data.message?.usage) {
        const u = data.message.usage;
        const read = Number(u.cache_read_input_tokens ?? 0) || 0;
        const write = Number(u.cache_creation_input_tokens ?? 0) || 0;
        const uncached = Number(u.input_tokens ?? 0) || 0;
        return {
            input: uncached + read + write,
            output: Number(u.output_tokens ?? 0) || 0,
        };
    }
    if (data.type === 'message_delta' && data.usage) {
        return { output: Number(data.usage.output_tokens ?? 0) || 0 };
    }

    // Google Gemini
    if (data.usageMetadata) {
        const u = data.usageMetadata;
        return {
            input: Number(u.promptTokenCount ?? 0) || 0,
            output: Number(u.candidatesTokenCount ?? 0) || 0,
        };
    }

    const u = data.usage;
    if (!u || typeof u !== 'object') return null;

    // OpenAI-compatible (also OpenRouter, DeepSeek, LiteLLM proxies, ...)
    if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens)) {
        return {
            input: Number(u.prompt_tokens ?? 0) || 0,
            output: Number(u.completion_tokens ?? 0) || 0,
        };
    }

    // Anthropic-style usage object without an event wrapper
    if (Number.isFinite(u.input_tokens)) {
        const read = Number(u.cache_read_input_tokens ?? 0) || 0;
        const write = Number(u.cache_creation_input_tokens ?? 0) || 0;
        return {
            input: (Number(u.input_tokens ?? 0) || 0) + read + write,
            output: Number(u.output_tokens ?? 0) || 0,
        };
    }

    return null;
}

/**
 * Merge a usage fragment into the pending captured usage.
 * Later chunks overwrite earlier ones (e.g. Anthropic message_delta output).
 * @param {{input?: number, output?: number}|null} fragment
 */
function mergeCapturedUsage(fragment) {
    if (!fragment) return;
    if (!capturedStreamUsage) capturedStreamUsage = {};
    for (const key of ['input', 'output']) {
        const value = Number(fragment[key]);
        if (Number.isFinite(value) && value >= 0) {
            capturedStreamUsage[key] = value;
        }
    }
}

/**
 * Reset the pending captured usage at the start of a generation.
 */
function resetCapturedUsage() {
    capturedStreamUsage = null;
    captureReaderDone = null;
}

/**
 * Await the capture reader (briefly) and return the captured usage, if any.
 * @returns {Promise<{input: number, output: number, hasTokenCounts: true}|null>}
 */
async function consumeCapturedUsage() {
    // The usage chunk is the last SSE event, so the reader is normally done by
    // the time the message events fire. Give it a short grace period just in case.
    if (captureReaderDone) {
        await Promise.race([
            captureReaderDone,
            new Promise(resolve => setTimeout(resolve, 250)),
        ]);
    }
    const usage = capturedStreamUsage;
    capturedStreamUsage = null;
    captureReaderDone = null;

    if (usage && (usage.input > 0 || usage.output > 0)) {
        return {
            input: usage.input || 0,
            output: usage.output || 0,
            hasTokenCounts: true,
        };
    }
    return null;
}

/**
 * Get usage for a specific chat
 * Per-chat tracking was removed with the v2 storage format; kept for API compatibility
 * @returns {Object} Zeroed usage
 */
function getChatUsage() {
    return { input: 0, output: 0, total: 0, messageCount: 0 };
}


/** @type {Promise<number>|null} Promise that resolves to input token count - started early, awaited later */
let pendingInputTokensPromise = null;
let pendingModelId = null;
// For 'continue' type generations, track the pre-continue token count so we can compute the delta
let preContinueTokenCount = 0;

/**
 * Count input tokens from the full prompt context (async helper)
 * @param {object} generate_data - The generation data containing the full prompt
 * @returns {Promise<number>} Total input token count
 */
async function countInputTokens(generate_data) {
    let inputTokens = 0;

    if (generate_data.prompt) {
        // For text completion APIs (kobold, novel, textgen) - prompt is a string
        if (typeof generate_data.prompt === 'string') {
            inputTokens = await countTokens(generate_data.prompt);
        } else if (Array.isArray(generate_data.prompt)) {
            // For chat completion APIs (OpenAI) - prompt is an array of messages
            for (const message of generate_data.prompt) {
                if (message.content) {
                    // Content can be a string or an array of content parts (for multimodal)
                    if (typeof message.content === 'string') {
                        inputTokens += await countTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        // Handle multimodal content (text + images)
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                inputTokens += await countTokens(part.text);
                            }
                            if (part.type === 'image_url' || part.type === 'image') {
                                // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                                // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                                inputTokens += 765;
                            }
                        }
                    }
                }
                // Count role tokens (~1 token per role)
                if (message.role) {
                    inputTokens += 1;
                }
                // Count name field tokens (used in function calls, tool results, etc.)
                if (message.name) {
                    inputTokens += await countTokens(message.name);
                }
                // Count tool_calls tokens (Standard OpenAI)
                if (Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                inputTokens += await countTokens(toolCall.function.name);
                            }
                            if (toolCall.function.arguments) {
                                inputTokens += await countTokens(toolCall.function.arguments);
                            }
                        }
                    }
                }
                // Count invocations tokens (SillyTavern internal)
                if (Array.isArray(message.invocations)) {
                    for (const invocation of message.invocations) {
                        if (invocation.function) {
                            if (invocation.function.name) {
                                inputTokens += await countTokens(invocation.function.name);
                            }
                            if (invocation.function.arguments) {
                                inputTokens += await countTokens(invocation.function.arguments);
                            }
                        }
                    }
                }
                // Count deprecated function_call tokens
                if (message.function_call) {
                    if (message.function_call.name) {
                        inputTokens += await countTokens(message.function_call.name);
                    }
                    if (message.function_call.arguments) {
                        inputTokens += await countTokens(message.function_call.arguments);
                    }
                }
            }
            // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
            inputTokens += generate_data.prompt.length * 3;
        }
    }

    return inputTokens;
}

/**
 * Handle GENERATE_AFTER_DATA event - start counting input tokens (non-blocking)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    // Capture model ID synchronously (fast)
    pendingModelId = getGeneratingModel();

    // Fresh capture slot for this generation's API-reported usage
    resetCapturedUsage();

    // Start token counting but DON'T await - let it run in parallel with the API request
    pendingInputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${pendingModelId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
let isQuietGeneration = false;
let isImpersonateGeneration = false;

async function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Track the generation type for special handling
    isQuietGeneration = (type === 'quiet');
    isImpersonateGeneration = (type === 'impersonate');

    // Reset pre-continue state
    preContinueTokenCount = 0;

    // For continue type, capture the current message's token count
    if (type === 'continue') {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    preContinueTokenCount = lastMessage.extra.token_count;
                } else {
                    // Calculate it ourselves
                    let tokens = await countTokens(lastMessage.mes || '');
                    if (lastMessage.extra?.reasoning) {
                        tokens += await countTokens(lastMessage.extra.reasoning);
                    }
                    preContinueTokenCount = tokens;
                }
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            preContinueTokenCount = 0;
        }
    }
}

/**
 * Handle message received event - count output tokens and record
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning)
 * Falls back to manual counting if not available
 *
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
async function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    // These events are emitted for messages created without calling the API
    const nonApiTypes = ['command', 'first_message'];
    if (nonApiTypes.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // If there's no pending token counting promise, this likely isn't a real API response
    // (e.g., could be a late-firing event after chat load)
    if (!pendingInputTokensPromise) {
        console.log(`[Token Usage Tracker] Skipping message with no pending token count (type: ${type || 'unknown'})`);
        return;
    }

    try {
        const context = getContext();
        const message = context.chat[messageIndex];

        if (!message || !message.mes) return;

        const apiUsage = parseApiUsage(message.extra?.api_usage) || await consumeCapturedUsage();
        let inputTokens;
        let outputTokens;

        if (apiUsage) {
            inputTokens = apiUsage.input;
            outputTokens = apiUsage.output;
            console.log(`[Token Usage Tracker] Using API-reported usage: ${inputTokens} in, ${outputTokens} out`);
        } else {
            // Use SillyTavern's pre-calculated token count if available.
            // This already includes reasoning tokens when power_user.message_token_count_enabled is true.
            if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
                outputTokens = message.extra.token_count;
                console.log(`[Token Usage Tracker] Using pre-calculated token count: ${outputTokens}`);
            } else {
                // Fall back to manual counting
                outputTokens = await countTokens(message.mes);

                // Also count reasoning/thinking tokens (from Claude thinking, OpenAI o1, etc.)
                if (message.extra?.reasoning) {
                    const reasoningTokens = await countTokens(message.extra.reasoning);
                    outputTokens += reasoningTokens;
                    console.log(`[Token Usage Tracker] Including ${reasoningTokens} reasoning tokens`);
                }
                console.log(`[Token Usage Tracker] Manually counted tokens: ${outputTokens}`);
            }
        }

        // For local-tokenizer continue records, subtract the pre-continue count.
        // API-reported completion tokens already describe the generated response.
        if (!apiUsage && type === 'continue' && preContinueTokenCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = preContinueTokenCount;
        preContinueTokenCount = 0;

        // Await the fallback input token count only when the API did not report it.
        if (inputTokens === undefined) {
            inputTokens = await pendingInputTokensPromise;
        } else {
            // Drain the pending promise so any tokenizer error handling has completed.
            pendingInputTokensPromise.catch(() => {});
        }
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Get current chat ID if available
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId, apiUsage);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${outputTokens} out, model: ${modelId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting output tokens:', error);
    }
}

/**
 * Handle generation stopped event - count tokens for cancelled/stopped generations
 * This ensures that input tokens (which were sent to the API) are still counted,
 * along with any partial output tokens that were generated before stopping.
 */
async function handleGenerationStopped() {
    // If there's no pending token counting promise, nothing to record
    if (!pendingInputTokensPromise) return;

    try {
        // Prefer API-reported usage (some providers still report usage when aborted)
        const captured = await consumeCapturedUsage();

        let outputTokens = 0;

        // Try to get partial output from the streaming processor
        if (streamingProcessor) {
            // Count main response text
            if (streamingProcessor.result) {
                outputTokens = await countTokens(streamingProcessor.result);
                console.log(`[Token Usage Tracker] Partial output from stopped generation: ${outputTokens} tokens`);
            }

            // Also count any reasoning tokens that were generated
            if (streamingProcessor.reasoningHandler?.reasoning) {
                const reasoningTokens = await countTokens(streamingProcessor.reasoningHandler.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} partial reasoning tokens`);
            }
        }

        // Await the input token counting that was started in handleGenerateAfterData
        let inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        preContinueTokenCount = 0; // Reset continue state too

        if (captured) {
            inputTokens = captured.input;
            outputTokens = captured.output || outputTokens;
        }

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(inputTokens, outputTokens, chatId, modelId, captured);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${inputTokens} in, ${outputTokens} out (partial), model: ${modelId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingInputTokensPromise = null;
        preContinueTokenCount = 0;
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingInputTokensPromise = null;
    pendingModelId = null;
    preContinueTokenCount = 0;
    isQuietGeneration = false;
    isImpersonateGeneration = false;
    resetCapturedUsage();
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit('tokenUsageUpdated', getUsageStats());
}

/**
 * Handle impersonate ready event - count output tokens for impersonation
 * This fires when impersonation completes and puts text into the input field
 * @param {string} text - The generated impersonation text
 */
async function handleImpersonateReady(text) {
    if (!pendingInputTokensPromise) return;

    try {
        // Await the input token counting that was started in handleGenerateAfterData
        let inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Count output tokens from the impersonated text
        let outputTokens = 0;
        if (text && typeof text === 'string') {
            outputTokens = await countTokens(text);
        }

        // Prefer API-reported usage
        const captured = await consumeCapturedUsage();
        if (captured) {
            inputTokens = captured.input;
            outputTokens = captured.output || outputTokens;
        }

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId, captured);


        // Reset impersonate state
        isImpersonateGeneration = false;
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling impersonate ready:', error);
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isImpersonateGeneration = false;
    }
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenusage',
        callback: async () => {
            const stats = getUsageStats();
            const output = [
                `Tokenizer: ${stats.tokenizer}`,
                `Session: ${stats.session.total} tokens (${stats.session.input} in, ${stats.session.output} out)`,
                `Today: ${stats.today.total} tokens`,
                `This Week: ${stats.thisWeek.total} tokens`,
                `This Month: ${stats.thisMonth.total} tokens`,
                `All Time: ${stats.allTime.total} tokens`,
            ].join('\n');
            return output;
        },
        returns: 'Token usage statistics',
        helpString: 'Displays current token usage statistics across different time periods.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenreset',
        callback: async (args) => {
            const scope = String(args || '').trim() || 'session';
            if (scope === 'all') {
                resetAllUsage();
                return 'All token usage data has been reset.';
            } else {
                resetSession();
                return 'Session token usage has been reset.';
            }
        },
        returns: 'Confirmation message',
        helpString: 'Resets token usage. Use /tokenreset for session only, or /tokenreset all for all data.',
    }));
}

/**
 * Public API exposed for frontend/UI components
 */
window['TokenUsageTracker'] = {
    getStats: getUsageStats,
    getUsageForRange,
    getChatUsage,
    resetSession,
    resetAllUsage,
    recordUsage,
    countTokens, // Expose the token counting function
    // Subscribe to updates
    onUpdate: (callback) => {
        eventSource.on('tokenUsageUpdated', callback);
    },
    // Unsubscribe from updates
    offUpdate: (callback) => {
        eventSource.removeListener('tokenUsageUpdated', callback);
    },
};

/**
 * Format token count with K/M suffix
 */
function formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

/**
 * Format number with commas
 */
function formatNumberFull(num) {
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Generate a random color using HSL for guaranteed distinctness
 * Colors are persisted once assigned to maintain consistency
 * @param {string} modelId - Model identifier
 * @returns {string} Hex color code
 */
function getModelColor(modelId) {
    const settings = getSettings();

    // Return persisted color if exists
    if (settings.modelColors[modelId]) {
        return settings.modelColors[modelId];
    }

    // Get all existing assigned colors to avoid duplicates
    const existingColors = Object.values(settings.modelColors);

    // Generate a random color that's distinct from existing ones
    let newColor;
    let attempts = 0;
    do {
        // Random hue (0-360), high saturation (60-80%), medium lightness (45-65%)
        const hue = Math.floor(Math.random() * 360);
        const sat = 60 + Math.floor(Math.random() * 20);
        const light = 45 + Math.floor(Math.random() * 20);
        newColor = hslToHex(hue, sat, light);
        attempts++;
    } while (attempts < 50 && isTooSimilar(newColor, existingColors));

    // Persist the new color
    settings.modelColors[modelId] = newColor;
    saveSettings();

    return newColor;
}

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Check if a color is too similar to any existing colors
 */
function isTooSimilar(newColor, existingColors) {
    for (const existing of existingColors) {
        if (colorDistance(newColor, existing) < 50) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate color distance (simple RGB euclidean)
 */
function colorDistance(c1, c2) {
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function renderInputOutputRows(prefix, input, output, requests, valueFontSize = '14px') {
    return `
        <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px 10px; color: var(--SmartThemeBodyColor);">
            <div style="font-size: 10px; opacity: 0.75;">In</div>
            <div style="font-size: 10px; opacity: 0.75;">Out</div>
            <div style="font-size: 10px; opacity: 0.75;">Requests</div>
            <div id="token-usage-${prefix}-in" style="font-size: ${valueFontSize}; font-weight: 600; color: var(--SmartThemeBodyColor);">${formatNumberFull(input || 0)}</div>
            <div id="token-usage-${prefix}-out" style="font-size: ${valueFontSize}; font-weight: 600; color: var(--SmartThemeBodyColor);">${formatNumberFull(output || 0)}</div>
            <div id="token-usage-${prefix}-requests" style="font-size: ${valueFontSize}; font-weight: 600; color: var(--SmartThemeBodyColor);">${formatNumberFull(requests || 0)}</div>
        </div>
    `;
}

function renderUsageStatCard(title, prefix, data) {
    return `
        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden;">
            <div style="padding: 6px 8px;">
                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5; margin-bottom: 4px;">${title}</div>
                ${renderInputOutputRows(prefix, data.input, data.output, data.messageCount)}
            </div>
        </div>
    `;
}

// Chart state
let currentChartRange = 30;
let chartData = [];
let tooltip = null;

// Chart colors - adapted for dark theme
const CHART_COLORS = {
    bar: 'var(--SmartThemeBorderColor)',
    text: 'var(--SmartThemeBodyColor)',
    grid: 'var(--SmartThemeBorderColor)',
    cursor: 'var(--SmartThemeBodyColor)',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSVGElement(type, attrs = {}) {
    const el = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

/**
 * Get chart data from real usage stats
 */
function getChartData(days) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, messageCount: 0, models: {} };

        data.push({
            date: date,
            dayKey: dayKey,
            usage: dayData.total || 0,
            input: dayData.input || 0,
            output: dayData.output || 0,
            messageCount: dayData.messageCount || 0,
            models: dayData.models || {},
            displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date),
        });
    }
    return data;
}

/**
 * Render the bar chart
 */
function renderChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = { top: 10, right: 10, bottom: 25, left: 45 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;',
    });


    const cursorGroup = createSVGElement('g', { class: 'cursors' });
    const gridGroup = createSVGElement('g', { class: 'grid' });
    const barGroup = createSVGElement('g', { class: 'bars' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(cursorGroup);
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4',
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif',
        });
        text.textContent = formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > 40) barWidth = 40;
    const actualGap = totalBarWidth - barWidth;
    const labelInterval = currentChartRange >= 365 ? 30 : currentChartRange >= 90 ? 7 : currentChartRange >= 30 ? 3 : 1;

    chartData.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (actualGap / 2);
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Hover area
        const cursor = createSVGElement('rect', {
            x: slotX,
            y: margin.top,
            width: totalBarWidth,
            height: chartHeight,
            fill: 'transparent',
            opacity: '0.1',
            class: 'cursor-rect',
            style: 'cursor: pointer;',
        });

        cursor.addEventListener('mouseenter', () => {
            cursor.setAttribute('fill', CHART_COLORS.cursor);
            showTooltip(d);
        });
        cursor.addEventListener('mousemove', (e) => {
            moveTooltip(e);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);
        const w = barWidth;

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${w} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        if (d.models && Object.keys(d.models).length > 0 && d.usage > 0) {
            // Extract total from new object format or use number directly for legacy
            const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
            const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1])); // Sort by usage desc

            let cumulativeY = barY + h; // Start from bottom

            for (const [modelId, modelData] of modelEntries) {
                const tokens = getTokens(modelData);
                const segmentHeight = (tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const color = getModelColor(modelId);
                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: '1',
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none',
                });
                barGroup.appendChild(segment);

                cumulativeY = segmentY;
            }
        }

        // Draw outer bar border (on top of segments)
        const outerPath = createSVGElement('path', {
            d: outerPathD,
            fill: 'none',
            stroke: CHART_COLORS.bar,
            'stroke-width': '1.5',
            'shape-rendering': 'geometricPrecision',
            'pointer-events': 'none',
        });
        barGroup.appendChild(outerPath);


        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': '10',
                'font-family': 'ui-sans-serif, system-ui, sans-serif',
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    container.appendChild(svg);
}

function showTooltip(d) {
    if (!tooltip) return;

    // Build model breakdown HTML
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        const getModelTokenBreakdown = (value) => {
            if (typeof value === 'number') {
                return { total: value, input: null, output: null, messageCount: null };
            }

            const input = Number(value?.input) || 0;
            const output = Number(value?.output) || 0;
            const total = Number(value?.total) || (input + output);
            const messageCount = Number(value?.messageCount);
            return { total, input, output, messageCount: Number.isFinite(messageCount) ? messageCount : null };
        };

        const modelEntries = Object.entries(d.models).sort((a, b) => getModelTokenBreakdown(a[1]).total - getModelTokenBreakdown(b[1]).total); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 2px; padding-top: 3px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const hiddenEntryCount = Math.max(0, modelEntries.length - 8);
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        if (hiddenEntryCount > 0) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3); margin-bottom: 2px;">+${hiddenEntryCount} more</div>`;
        }
        for (const [model, modelData] of displayEntries) {
            const { total, input, output, messageCount } = getModelTokenBreakdown(modelData);
            const percent = d.usage > 0 ? Math.round((total / d.usage) * 100) : 0;
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);
            const breakdownLines = input !== null && output !== null
                ? `
                    <div style="margin-top: 0; margin-left: 12px; color: rgba(255,255,255,0.65); line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${formatNumberFull(input)} | ${formatNumberFull(output)}${messageCount !== null ? ` | ${formatNumberFull(messageCount)}` : ''}
                    </div>
                `
                : `
                    <div style="margin-top: 0; margin-left: 12px; color: rgba(255,255,255,0.65); line-height: 1.15;">
                        <div>Total: ${formatNumberFull(total)}</div>
                    </div>
                `;

            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); margin-bottom: 2px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                    <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                        <span style="display: inline-block; width: 7px; height: 7px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                    </div>
                    <span style="flex-shrink: 0;">${percent}%</span>
                </div>
                ${breakdownLines}
            </div>`;
        }
        modelBreakdown += '</div>';
    }

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px 10px; font-size: 10px; color: var(--SmartThemeBodyColor); margin-bottom: 2px;">
            <div style="opacity: 0.6;">In</div>
            <div style="opacity: 0.6;">Out</div>
            <div style="opacity: 0.6;">Requests</div>
            <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.input)}</div>
            <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.output)}</div>
            <div style="font-size: 11px; font-weight: 600; opacity: 1;">${formatNumberFull(d.messageCount)}</div>
        </div>
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

function moveTooltip(e) {
    if (!tooltip) return;

    const tooltipWidth = tooltip.offsetWidth || 150;
    const tooltipHeight = tooltip.offsetHeight || 60;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = e.clientX + 15;
    let y = e.clientY - 10;

    // Keep tooltip within viewport
    if (x + tooltipWidth > viewportWidth - 10) {
        x = e.clientX - tooltipWidth - 15;
    }
    if (y + tooltipHeight > viewportHeight - 10) {
        y = viewportHeight - tooltipHeight - 10;
    }
    if (y < 10) {
        y = 10;
    }
    if (x < 10) {
        x = 10;
    }

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartData(range);
    renderChart();

    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        const val = parseInt(btn.getAttribute('data-value'));
        if (val === range) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

/**
 * Update the stats display in the UI (wand popup + extensions drawer)
 */
function updateUIStats() {
    const stats = getUsageStats();

    // Stat cards live in the usage popup; update only when it is open
    const setIf = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setIf('token-usage-today-in', formatNumberFull(stats.today.input || 0));
    setIf('token-usage-today-out', formatNumberFull(stats.today.output || 0));
    setIf('token-usage-today-requests', formatNumberFull(stats.today.messageCount || 0));

    setIf('token-usage-week-in', formatNumberFull(stats.thisWeek.input || 0));
    setIf('token-usage-week-out', formatNumberFull(stats.thisWeek.output || 0));
    setIf('token-usage-week-requests', formatNumberFull(stats.thisWeek.messageCount || 0));

    setIf('token-usage-month-in', formatNumberFull(stats.thisMonth.input || 0));
    setIf('token-usage-month-out', formatNumberFull(stats.thisMonth.output || 0));
    setIf('token-usage-month-requests', formatNumberFull(stats.thisMonth.messageCount || 0));

    setIf('token-usage-alltime-in', formatNumberFull(stats.allTime.input || 0));
    setIf('token-usage-alltime-out', formatNumberFull(stats.allTime.output || 0));
    setIf('token-usage-alltime-requests', formatNumberFull(stats.allTime.messageCount || 0));

    setIf('token-usage-tokenizer', 'Tokenizer: ' + (stats.tokenizer || 'Unknown'));

    // Update chart if the popup is open
    chartData = getChartData(currentChartRange);
    renderChart();

    // Update the per-model token list in the extensions drawer
    renderModelUsageList();
}

/**
 * Render the per-model token counts list in the extensions drawer
 * (replaces the old colors/prices "Config" section)
 */
function renderModelUsageList() {
    const grid = document.getElementById('token-usage-model-list');
    if (!grid) return;

    const byModel = usageRuntime.byModel || {};
    const models = Object.keys(byModel).sort((a, b) => (byModel[b].total || 0) - (byModel[a].total || 0));

    if (models.length === 0) {
        grid.innerHTML = '<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.5; padding: 4px; text-align: center;">No models tracked yet</div>';
        return;
    }

    grid.innerHTML = models.map((model) => {
        const data = byModel[model] || {};
        const color = getModelColor(model);
        return `
            <div class="token-usage-model-row" style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                <span style="display: inline-block; width: 7px; height: 7px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                <span title="${model}" style="font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--SmartThemeBodyColor); flex: 1; min-width: 0;">${model}</span>
                <span title="In | Out | Requests" style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.75; white-space: nowrap; flex-shrink: 0;">
                    ${formatTokens(data.input || 0)} | ${formatTokens(data.output || 0)} | ${formatTokens(data.messageCount || 0)}
                </span>
            </div>
        `;
    }).join('');
}

// ============================================================
// Usage popup (Extensions wand menu)
// ============================================================

/** Track whether the usage popup is open, and the tooltip element reference */
let usagePopupOpen = false;

/**
 * Build the popup content HTML (chart + stat cards)
 * @returns {string}
 */
function getUsagePopupHtml() {
    const stats = getUsageStats();
    return `
        <div id="token-usage-popup">
            <div class="token-usage-chart-shell" style="margin-bottom: 12px;">
                <div class="token-usage-range-controls" style="display: inline-flex; flex-wrap: wrap; justify-content: flex-end;">
                    <button class="token-usage-range-btn menu_button" data-value="7" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">7D</button>
                    <button class="token-usage-range-btn menu_button active" data-value="30" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">30D</button>
                    <button class="token-usage-range-btn menu_button" data-value="90" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">90D</button>
                    <button class="token-usage-range-btn menu_button" data-value="365" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">365D</button>
                </div>
                <div id="token-usage-chart" style="width: 100%; height: 320px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden;"></div>
            </div>
            <div class="token-usage-stats-grid" style="display: grid; gap: 6px; margin-bottom: 4px;">
                ${renderUsageStatCard('Today', 'today', stats.today)}
                ${renderUsageStatCard('This Week', 'week', stats.thisWeek)}
                ${renderUsageStatCard('This Month', 'month', stats.thisMonth)}
                ${renderUsageStatCard('All Time', 'alltime', stats.allTime)}
            </div>
        </div>
    `;
}

/**
 * Wire up the chart controls inside an open popup
 */
function bindUsagePopupControls() {
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
        });
    });

    // Re-render the chart when the popup body resizes
    const chartContainer = document.getElementById('token-usage-chart');
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (usagePopupOpen) {
                    renderChart();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }
}

/**
 * Open the usage popup from the Extensions wand menu
 */
async function openUsagePopup() {
    const context = getContext();
    const { Popup, POPUP_TYPE } = context;
    if (!Popup) {
        console.error('[Token Usage Tracker] Popup API not available');
        return;
    }

    // SillyTavern popups are native <dialog> elements shown with showModal(),
    // which renders them in the browser's top layer — above every page element
    // regardless of z-index. Only children of the dialog itself can float above
    // the popup content (the same approach ST uses for toasts inside popups),
    // so the tooltip is appended to the dialog element, not to <body>.
    let tooltipEl = document.getElementById('token-usage-tooltip');
    if (!tooltipEl || !tooltipEl.isConnected) {
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.9); color: white; padding: 6px 10px; border-radius: 6px; font-size: 11px; pointer-events: none; z-index: 2147483647; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
    }
    tooltip = tooltipEl;

    usagePopupOpen = true;
    const popup = new Popup(getUsagePopupHtml(), POPUP_TYPE.DISPLAY, '', {
        wide: true,
        allowVerticalScrolling: true,
        transparent: false,
        onOpen: () => {
            bindUsagePopupControls();
            chartData = getChartData(currentChartRange);
            updateChartRange(currentChartRange);
            updateUIStats();
        },
        onClose: () => {
            usagePopupOpen = false;
            if (tooltip) {
                tooltip.style.display = 'none';
            }
        },
    });

    // Move the tooltip into the dialog so it renders above the popup content
    // (the dialog sits in the browser's top layer; body children cannot).
    if (popup.dlg) {
        popup.dlg.appendChild(tooltip);
    }

    await popup.show();
}

/**
 * Add an "Open Token Usage" entry to the Extensions wand dropdown
 * (#extensionsMenu). ST reveals the wand button once the menu has any
 * visible children, so we just need to append one. The menu is appended
 * to <body> after third-party extension scripts load, so retry briefly.
 */
function initWandMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        if ((initWandMenuButton._tries = (initWandMenuButton._tries || 0) + 1) <= 25) {
            setTimeout(initWandMenuButton, 200);
        }
        return;
    }
    if (menu.querySelector('#token-usage-wand-open')) return; // idempotent

    const item = document.createElement('div');
    item.id = 'token-usage-wand-open';
    item.className = 'list-group-item flex-container flexGap5';
    item.setAttribute('title', 'Open Token Usage statistics');
    item.innerHTML = '<div class="fa-solid fa-chart-column extensionsMenuExtensionButton"></div><span>Token Usage</span>';
    item.addEventListener('click', () => {
        $('#extensionsMenu').fadeOut(150);
        openUsagePopup();
    });
    menu.appendChild(item);
}

/**
 * Create the settings UI in the extensions panel
 * Kept minimal: per-model token counts + controls. The chart and stat
 * cards live in the wand-menu popup instead.
 */
function createSettingsUI() {
    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Per-model token counts (replaces the old Config section) -->
                    <div id="token-usage-model-list" style="display: grid; grid-template-columns: 1fr; gap: 3px; margin-bottom: 8px;"></div>

                    <!-- Controls -->
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-tokenizer">Tokenizer: Unknown</div>
                        <div style="flex: 1;"></div>
                        <div id="token-usage-open-popup" class="menu_button" title="Open the usage chart and stats" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-chart-column"></i>&nbsp;Stats
                        </div>
                        <div id="token-usage-export" class="menu_button" title="Download all usage data as CSV" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-download"></i>&nbsp;Export
                        </div>
                        <div id="token-usage-reset-all" class="menu_button" title="Reset all stats" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-trash"></i>&nbsp;Reset All
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const targetContainer = $('#extensions_settings2');
    if (targetContainer.length > 0) {
        targetContainer.append(html);
        console.log('[Token Usage Tracker] UI appended to extensions_settings2');
    } else {
        const fallback = $('#extensions_settings');
        if (fallback.length > 0) {
            fallback.append(html);
            console.log('[Token Usage Tracker] UI appended to extensions_settings (fallback)');
        }
    }

    $('#token-usage-open-popup').on('click', openUsagePopup);
    $('#token-usage-export').on('click', exportUsageCsv);

    $('#token-usage-reset-all').on('click', function () {
        if (confirm('Are you sure you want to reset ALL token usage data? This cannot be undone.')) {
            resetAllUsage();
            updateUIStats();
            toastr.success('All stats reset');
        }
    });

    // Wand menu entry (opens the same popup from the extensions menu)
    initWandMenuButton();

    // Initial render of the model list
    renderModelUsageList();

    // Subscribe to updates
    eventSource.on('tokenUsageUpdated', updateUIStats);

    // Fallback: window resize re-renders the chart if the popup is open
    window.addEventListener('resize', () => {
        clearTimeout(createSettingsUI._resizeTimeout);
        createSettingsUI._resizeTimeout = setTimeout(() => {
            if (usagePopupOpen) renderChart();
        }, 100);
    });
}

/**
 * Patch SillyTavern's background generation functions to track tokens
 * - generateQuiet / generate_quiet (Used by Summarize, generated prompts, etc.)
 * - ConnectionManagerRequestService.sendRequest (Used by extensions like Roadway)
 */
let isTrackingBackground = false;

function patchBackgroundGenerations() {
    patchGenerateQuietPrompt();
    patchConnectionManager();
}

function patchGenerateQuietPrompt() {
    // For quiet generations (Guided Generations, Summarize, Expressions, etc.),
    // MESSAGE_RECEIVED doesn't fire. Flush pending tokens on next generation or chat change.
    eventSource.on(event_types.GENERATION_STARTED, async (type, params, dryRun) => {
        if (dryRun) return;
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });
}

/**
 * Flush a pending quiet generation, recording tokens from what we have
 */
async function flushQuietGeneration() {
    if (!pendingInputTokensPromise) return;

    try {
        let inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;

        // Try to get output from streaming processor
        let outputTokens = 0;
        if (streamingProcessor?.result) {
            outputTokens = await countTokens(streamingProcessor.result);
        }

        // Prefer API-reported usage
        const captured = await consumeCapturedUsage();
        if (captured) {
            inputTokens = captured.input;
            outputTokens = captured.output || outputTokens;
        }

        // Record the usage
        if (inputTokens > 0 || outputTokens > 0) {
            recordUsage(inputTokens, outputTokens, null, modelId, captured);
        }
    } catch (e) {
        console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
    } finally {
        // Reset state
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isQuietGeneration = false;
    }
}

function patchConnectionManager() {
    // Poll for ConnectionManagerRequestService (used by Roadway and similar extensions)
    const checkInterval = setInterval(() => {
        try {
            const context = getContext();
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(checkInterval);
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

            ServiceClass.sendRequest = async function(profileId, messages, maxTokens, custom, overridePayload) {
                if (isTrackingBackground) {
                    return await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
                }

                let inputTokens = 0;
                const modelId = getGeneratingModel();

                try {
                    isTrackingBackground = true;

                    try {
                        inputTokens = await countInputTokens({ prompt: messages });
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest input:', e);
                    }

                    const result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);

                    try {
                        let outputTokens = 0;
                        if (result && typeof result.content === 'string') {
                            outputTokens = await countTokens(result.content);
                        } else if (typeof result === 'string') {
                            outputTokens = await countTokens(result);
                        }

                        // Prefer API-reported usage from the underlying request
                        const captured = await consumeCapturedUsage();
                        if (captured?.input) inputTokens = captured.input;
                        if (captured?.output) outputTokens = captured.output;

                        if (outputTokens > 0 || inputTokens > 0) {
                            recordUsage(inputTokens, outputTokens, null, modelId, captured);
                        }
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest output:', e);
                    }

                    return result;
                } finally {
                    isTrackingBackground = false;
                }
            };

            ServiceClass.sendRequest._isPatched = true;
            clearInterval(checkInterval);
        } catch (e) {
            console.error('[Token Usage Tracker] Error in patchConnectionManager:', e);
        }
    }, 1000);

    // Stop polling after 30 seconds
    setTimeout(() => clearInterval(checkInterval), 30000);
}

/**
 * Generic handler for background generations with recursion guard
 */
async function handleBackgroundGeneration(originalFn, context, args, inputCounter, outputCounter) {
    // Avoid double counting if one patched function calls another
    if (isTrackingBackground) {
        return await originalFn.apply(context, args);
    }

    let result;
    let inputTokens = 0;
    const modelId = getGeneratingModel();

    try {
        isTrackingBackground = true;

        // Count input tokens
        try {
            inputTokens = await inputCounter();
            console.log(`[Token Usage Tracker] Counting background input. Tokens: ${inputTokens}`);
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background input:', e);
        }

        // Execute original
        result = await originalFn.apply(context, args);

        // Count output tokens
        try {
            const outputTokens = await outputCounter(result);
            if (outputTokens > 0 || inputTokens > 0) {
                recordUsage(inputTokens, outputTokens, null, modelId);
                console.log(`[Token Usage Tracker] Background usage recorded: ${inputTokens} in, ${outputTokens} out`);
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background output:', e);
        }
    } finally {
        isTrackingBackground = false;
    }

    return result;
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Capture API-reported usage from generate responses
    installUsageCapture();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);

    // Log current tokenizer
    try {
        const { tokenizerName } = getFriendlyTokenizerName(main_api);
        console.log(`[Token Usage Tracker] Using tokenizer: ${tokenizerName}`);
    } catch (e) {
        console.log('[Token Usage Tracker] Tokenizer will be determined when API is connected');
    }

    console.log('[Token Usage Tracker] Use /tokenusage to see stats, /tokenreset to reset session');

    // Emit initial stats for any listening UI
    setTimeout(() => {
        eventSource.emit('tokenUsageUpdated', getUsageStats());
    }, 1000);
});
