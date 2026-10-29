/**
 * Token Usage Tracker — storage layer
 *
 * Usage history is persisted in a compact "v3" form to keep settings.json small:
 *
 *   {
 *     v: 3,
 *     session: {...},                       // unchanged runtime shape
 *     allTime: {...},                       // unchanged runtime shape
 *     models: ["vendor/model:variant"...],  // intern table shared by all buckets
 *     days: [                               // sorted by date key
 *       {
 *         d: "2026-08-30",                  // day key
 *         i, o, n,                          // input, output, message count
 *         s: [                              // per-model rows:
 *           [modelIdx, in, out, msgCount]
 *         ]
 *       }
 *     ],
 *     byModel: [                            // all-time per-model aggregates
 *       [modelIdx, in, out, msgCount]
 *     ]
 *   }
 *
 * The runtime shape is unchanged (byDay object + byModel object), so all
 * readers keep working; conversion happens only at the persistence boundary.
 * `byModel` is stored (not derived from days) because historical day rows can
 * contain estimates from the v1 numeric-format migration, while byModel holds
 * the authoritative totals.
 *
 * v3 dropped the v2 cost fields (cost/costedInput/costedOutput).
 */

const V3 = 3;
const V2 = 2;

export function createEmptyRuntime() {
    return {
        session: { input: 0, output: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
        byDay: {},
        byModel: {},
    };
}

/** Deserialize one [modelIdx, in, out, msgCount] row */
function rowToBucket(row) {
    const bucket = {
        input: row[1] || 0,
        output: row[2] || 0,
        total: (row[1] || 0) + (row[2] || 0),
        messageCount: row[3] || 0,
    };
    return bucket;
}

/** Serialize a runtime bucket to [idx, in, out, msgCount] */
function bucketToRow(idx, bucket) {
    return [idx, bucket.input || 0, bucket.output || 0, bucket.messageCount || 0];
}

/**
 * Expand compact v3 into the runtime shape.
 * @param {object} compact
 * @returns {object} { session, allTime, byDay, byModel }
 */
export function deserializeUsage(compact) {
    const runtime = createEmptyRuntime();
    if (!compact || compact.v !== V3 || !Array.isArray(compact.days)) {
        return runtime;
    }

    runtime.session = { ...createEmptyRuntime().session, ...(compact.session || {}) };
    runtime.allTime = { ...createEmptyRuntime().allTime, ...(compact.allTime || {}) };

    const models = Array.isArray(compact.models) ? compact.models : [];

    for (const day of compact.days) {
        if (!day || typeof day.d !== 'string') continue;
        const dayData = {
            input: day.i || 0,
            output: day.o || 0,
            total: (day.i || 0) + (day.o || 0),
            messageCount: day.n || 0,
            models: {},
        };

        for (const row of (day.s || [])) {
            const modelId = models[row[0]];
            if (typeof modelId !== 'string') continue;
            dayData.models[modelId] = rowToBucket(row);
        }

        runtime.byDay[day.d] = dayData;
    }

    for (const row of (compact.byModel || [])) {
        const modelId = models[row[0]];
        if (typeof modelId !== 'string') continue;
        runtime.byModel[modelId] = rowToBucket(row);
    }

    return runtime;
}

/**
 * Compact the runtime shape into v3 for persistence.
 * @param {object} runtime { session, allTime, byDay, byModel }
 * @returns {object} compact v3 object (assign this over extension settings)
 */
export function serializeUsage(runtime) {
    const byDay = (runtime && runtime.byDay) || {};
    const dayKeys = Object.keys(byDay).sort();
    const modelIndex = new Map();

    const intern = (modelId) => {
        let idx = modelIndex.get(modelId);
        if (idx === undefined) {
            idx = modelIndex.size;
            modelIndex.set(modelId, idx);
        }
        return idx;
    };

    const days = dayKeys.map((dayKey) => {
        const day = byDay[dayKey];
        const compact = {
            d: dayKey,
            i: day.input || 0,
            o: day.output || 0,
            n: day.messageCount || 0,
        };

        compact.s = Object.entries(day.models || {}).map(([modelId, modelData]) =>
            bucketToRow(intern(modelId), modelData));
        return compact;
    });

    const byModelRows = Object.entries((runtime && runtime.byModel) || {})
        .map(([modelId, bucket]) => bucketToRow(intern(modelId), bucket));

    return {
        v: V3,
        session: runtime.session || createEmptyRuntime().session,
        allTime: runtime.allTime || createEmptyRuntime().allTime,
        models: Array.from(modelIndex.keys()),
        days,
        byModel: byModelRows,
    };
}

/**
 * One-time conversion from the v1/v2 layouts to compact v3.
 * Accepts either the v1 runtime layout or the v2 compact layout.
 * Drops the dead legacy buckets (byHour/byWeek/byMonth/byChat — never written
 * by current code and never displayed), folds the legacy numeric models format,
 * and discards cost fields.
 * @param {object} raw v1 runtime or v2 compact usage object (not modified)
 * @returns {object} compact v3 object
 */
export function migrateUsageV1(raw) {
    if (raw && raw.v === V3) return raw;

    if (raw && raw.v === V2) {
        // v2 compact: expand into the runtime shape first (dropping cost fields)
        return serializeUsage(deserializeV2(raw));
    }

    // v1 runtime layout: normalize legacy numeric per-model totals, then compact.
    const normalized = JSON.parse(JSON.stringify(raw || {}));
    for (const day of Object.values(normalized.byDay || {})) {
        const dayTotal = day.total || 0;
        for (const [modelId, value] of Object.entries(day.models || {})) {
            if (typeof value === 'number') {
                day.models[modelId] = {
                    input: Math.round((day.input || 0) * (dayTotal ? value / dayTotal : 0)),
                    output: Math.round((day.output || 0) * (dayTotal ? value / dayTotal : 0)),
                    total: value,
                    messageCount: 0,
                };
            }
        }
    }
    return serializeUsage(normalized);
}

/** Expand compact v2 (with cost fields) into the runtime shape, ignoring costs. */
function deserializeV2(compact) {
    const runtime = createEmptyRuntime();
    if (!compact || compact.v !== V2 || !Array.isArray(compact.days)) {
        return runtime;
    }

    runtime.session = { ...createEmptyRuntime().session, ...(compact.session || {}) };
    runtime.allTime = { ...createEmptyRuntime().allTime, ...(compact.allTime || {}) };

    const models = Array.isArray(compact.models) ? compact.models : [];

    for (const day of compact.days) {
        if (!day || typeof day.d !== 'string') continue;
        const dayData = {
            input: day.i || 0,
            output: day.o || 0,
            total: (day.i || 0) + (day.o || 0),
            messageCount: day.n || 0,
            models: {},
        };

        for (const row of (day.s || [])) {
            const modelId = models[row[0]];
            if (typeof modelId !== 'string') continue;
            dayData.models[modelId] = {
                input: row[1] || 0,
                output: row[2] || 0,
                total: (row[1] || 0) + (row[2] || 0),
                messageCount: row[3] || 0,
            };
        }

        runtime.byDay[day.d] = dayData;
    }

    for (const row of (compact.byModel || [])) {
        const modelId = models[row[0]];
        if (typeof modelId !== 'string') continue;
        runtime.byModel[modelId] = {
            input: row[1] || 0,
            output: row[2] || 0,
            total: (row[1] || 0) + (row[2] || 0),
            messageCount: row[3] || 0,
        };
    }

    return runtime;
}

function csvEscape(value) {
    const str = String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Build a CSV of the full usage history: one row per day x model.
 * @param {object} runtime { byDay }
 * @returns {string} CSV text
 */
export function buildUsageCsv(runtime) {
    const byDay = (runtime && runtime.byDay) || {};
    const lines = ['date,model,input_tokens,output_tokens,total_tokens,requests'];

    for (const dayKey of Object.keys(byDay).sort()) {
        const day = byDay[dayKey];
        const modelEntries = Object.entries(day.models || {}).sort(([a], [b]) => a.localeCompare(b));

        let modelInput = 0;
        let modelOutput = 0;
        let modelRequests = 0;
        for (const [modelId, modelData] of modelEntries) {
            modelInput += modelData.input || 0;
            modelOutput += modelData.output || 0;
            modelRequests += modelData.messageCount || 0;
            lines.push([
                dayKey,
                csvEscape(modelId),
                modelData.input || 0,
                modelData.output || 0,
                modelData.total != null ? modelData.total : (modelData.input || 0) + (modelData.output || 0),
                modelData.messageCount || 0,
            ].join(','));
        }

        // Background/quiet generations are recorded without a model ID and only
        // roll into the day totals — surface the remainder as an unattributed row.
        const unattributedInput = (day.input || 0) - modelInput;
        const unattributedOutput = (day.output || 0) - modelOutput;
        const unattributedRequests = (day.messageCount || 0) - modelRequests;
        if (unattributedInput > 0 || unattributedOutput > 0 || unattributedRequests > 0) {
            lines.push([
                dayKey,
                '(unattributed)',
                unattributedInput,
                unattributedOutput,
                unattributedInput + unattributedOutput,
                unattributedRequests,
            ].join(','));
        }
    }

    return lines.join('\n') + '\n';
}
