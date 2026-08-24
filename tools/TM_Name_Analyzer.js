/*
 * TM Name Analyzer
 * Browser-friendly NER helpers adapted from vBook's LAC/TexSmart/IBM flow.
 * UI, book storage and Vietnamese suggestions intentionally stay in TM Translate.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TMNameAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = '1.1.0';
    const TYPES = Object.freeze({
        PER: 'Nhân danh',
        LOC: 'Địa danh',
        ORG: 'Tổ chức'
    });
    const ENGINES = Object.freeze({
        lac: Object.freeze({ id: 'lac', label: 'LAC Local', available: true, local: true }),
        texsmart: Object.freeze({ id: 'texsmart', label: 'TexSmart', available: true, local: false }),
        ibm: Object.freeze({ id: 'ibm', label: 'IBM', available: true, local: false })
    });
    const HAN_REGEX = /\p{Script=Han}/u;

    function abortError() {
        try {
            return new DOMException('Đã dừng phân tích.', 'AbortError');
        } catch (_) {
            const error = new Error('Đã dừng phân tích.');
            error.name = 'AbortError';
            return error;
        }
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw abortError();
    }

    function wait(ms, signal) {
        const delay = Math.max(0, Number(ms) || 0);
        if (!delay) {
            throwIfAborted(signal);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(done, delay);
            function done() {
                signal?.removeEventListener?.('abort', cancel);
                resolve();
            }
            function cancel() {
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', cancel);
                reject(abortError());
            }
            if (signal?.aborted) cancel();
            else signal?.addEventListener?.('abort', cancel, { once: true });
        });
    }

    function normalizeInput(text) {
        return String(text || '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gi, '')
            .replace(/[ \t\u3000]+/g, '')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function splitText(text, maxChars = 6000) {
        const source = normalizeInput(text);
        const limit = Math.max(800, Math.min(12000, Number(maxChars) || 6000));
        if (!source) return [];
        if (source.length <= limit) return [source];
        const chunks = [];
        let cursor = 0;
        while (cursor < source.length) {
            let end = Math.min(source.length, cursor + limit);
            if (end < source.length) {
                const floor = cursor + Math.floor(limit * 0.55);
                const window = source.slice(floor, end);
                const matches = Array.from(window.matchAll(/[。！？!?；;\n]/g));
                const boundary = matches.length ? matches[matches.length - 1].index : -1;
                if (boundary >= 0) end = floor + boundary + 1;
            }
            chunks.push(source.slice(cursor, end));
            cursor = end;
        }
        return chunks.filter(Boolean);
    }

    function normalizeType(type) {
        const value = String(type || '').trim().toLowerCase();
        if (!value) return '';
        if (value === 'per' || value === 'person' || value.startsWith('person.')) return 'PER';
        if (value === 'loc' || value === 'location' || value.startsWith('loc.')) return 'LOC';
        if (value === 'org' || value === 'organization' || value === 'facility' || value.startsWith('org.')) return 'ORG';
        return '';
    }

    function cleanWord(word) {
        return String(word || '').replace(/[\s\u3000]+/g, '').trim();
    }

    function normalizeEntity(word, type, engine, confidence = null) {
        const normalizedWord = cleanWord(word);
        const normalizedType = normalizeType(type);
        if (!normalizedWord || !normalizedType || !HAN_REGEX.test(normalizedWord)) return null;
        return {
            word: normalizedWord,
            type: normalizedType,
            engine,
            confidence: confidence !== null && confidence !== '' && Number.isFinite(Number(confidence))
                ? Number(confidence)
                : null
        };
    }

    function makeTexSmartRequest(text) {
        return {
            method: 'POST',
            url: 'https://texsmart.qq.com/api/',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                str: String(text || ''),
                options: {
                    text_norm: { restore_case: true },
                    input_spec: { lang: 'auto' },
                    word_seg: { person_as_one_word: true },
                    pos_tagging: { enable: true, alg: 'dnn' },
                    ner: { enable: true, alg: 'fine.std', entity_linking: false },
                    fnr: { enable: true },
                    syntactic_parsing: { enable: false },
                    srl: { enable: false }
                }
            }),
            timeout: 30000
        };
    }

    function makeIbmRequest(text) {
        return {
            method: 'POST',
            url: 'https://www.ibm.com/demos/live/natural-language-understanding/api/nlu',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                is_custom: false,
                sentiment_targets: [],
                text: String(text || '')
            }),
            timeout: 30000
        };
    }

    function asJson(payload) {
        if (payload && typeof payload === 'object') return payload;
        const text = String(payload || '').replace(/^\uFEFF/, '').trim();
        if (!text || !/^[\[{]/.test(text)) throw new Error('Engine không trả JSON hợp lệ.');
        return JSON.parse(text);
    }

    function parseTexSmart(payload) {
        const data = asJson(payload);
        if (data?.header?.ret_code && data.header.ret_code !== 'succ') {
            throw new Error(`TexSmart: ${data.header.ret_code}`);
        }
        return (Array.isArray(data?.entity_list) ? data.entity_list : [])
            .map(item => normalizeEntity(item?.str, item?.tag || item?.type?.name, 'texsmart'))
            .filter(Boolean);
    }

    function parseIbm(payload) {
        const data = asJson(payload);
        const entities = data?.default?.entities;
        if (!Array.isArray(entities)) throw new Error('IBM không còn trả danh sách entities.');
        return entities
            .filter(item => Number(item?.confidence) >= 0.6)
            .map(item => normalizeEntity(item?.text, item?.type, 'ibm', item?.confidence))
            .filter(Boolean);
    }

    function parseLacOutput(payload) {
        const rows = Array.isArray(payload) ? payload : String(payload || '').split(/\r?\n/);
        return rows.map(row => {
            if (row && typeof row === 'object') {
                return normalizeEntity(row.word || row.text, row.type || row.tag, 'lac', row.confidence);
            }
            const match = String(row || '').trim().match(/^(.+?)[=\t](PER|LOC|ORG)$/i);
            return match ? normalizeEntity(match[1], match[2], 'lac') : null;
        }).filter(Boolean);
    }

    function countLiteral(text, needle) {
        if (!needle) return 0;
        let count = 0;
        let cursor = 0;
        while (cursor <= text.length - needle.length) {
            const index = text.indexOf(needle, cursor);
            if (index < 0) break;
            count++;
            cursor = index + Math.max(1, needle.length);
        }
        return count;
    }

    function mergeEntities(entities, corpus, options = {}) {
        const minLength = Math.max(1, Number(options.minLength) || 2);
        const maxLength = Math.max(minLength, Number(options.maxLength) || 5);
        const minFrequency = Math.max(1, Number(options.minFrequency) || 1);
        const enabledTypes = new Set(Array.isArray(options.types) && options.types.length ? options.types : Object.keys(TYPES));
        const existing = new Set(Array.isArray(options.existingNames) ? options.existingNames : []);
        const skipExisting = options.skipExisting !== false;
        const merged = new Map();
        for (const entity of entities || []) {
            const word = cleanWord(entity?.word);
            const type = normalizeType(entity?.type);
            const hanLength = Array.from(word).filter(char => HAN_REGEX.test(char)).length;
            if (!word || !type || !enabledTypes.has(type) || hanLength < minLength || hanLength > maxLength) continue;
            if (skipExisting && existing.has(word)) continue;
            let item = merged.get(word);
            if (!item) {
                item = { word, type, typeVotes: {}, engines: new Set(), engineHits: 0, confidence: null };
                merged.set(word, item);
            }
            item.typeVotes[type] = (item.typeVotes[type] || 0) + 1;
            item.engines.add(entity.engine);
            item.engineHits++;
            if (entity.confidence !== null && (item.confidence === null || entity.confidence > item.confidence)) {
                item.confidence = entity.confidence;
            }
        }
        const normalizedCorpus = normalizeInput(corpus);
        return Array.from(merged.values()).map(item => {
            const type = Object.entries(item.typeVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || item.type;
            return {
                word: item.word,
                type,
                count: countLiteral(normalizedCorpus, item.word),
                engineHits: item.engineHits,
                engines: Array.from(item.engines),
                confidence: item.confidence,
                exists: existing.has(item.word)
            };
        }).filter(item => item.count >= minFrequency)
            .sort((a, b) => b.count - a.count || b.word.length - a.word.length || a.word.localeCompare(b.word, 'zh'));
    }

    function getAdapter(engine) {
        if (engine === 'texsmart') return { makeRequest: makeTexSmartRequest, parse: parseTexSmart };
        if (engine === 'ibm') return { makeRequest: makeIbmRequest, parse: parseIbm };
        return null;
    }

    async function requestWithRetry(request, spec, signal, retryCount) {
        let lastError = null;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
            throwIfAborted(signal);
            try {
                return await request(spec, { signal });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                lastError = error;
                if (attempt < retryCount) await wait(500 * (attempt + 1), signal);
            }
        }
        throw lastError || new Error('Request NER thất bại.');
    }

    async function analyze(options = {}) {
        const chapters = (Array.isArray(options.chapters) ? options.chapters : [])
            .map((chapter, index) => ({
                index,
                title: String(chapter?.title || ''),
                text: normalizeInput(chapter?.text || '')
            })).filter(chapter => chapter.text);
        const engines = Array.from(new Set((options.engines || ['texsmart'])
            .map(value => String(value || '').toLowerCase())
            .filter(engine => ENGINES[engine]?.available)
            .filter(engine => engine !== 'lac' || typeof options.localAnalyze === 'function')));
        if (!chapters.length) return { results: [], warnings: [], stats: { requests: 0, completed: 0 } };
        if (!engines.length) throw new Error('Chưa chọn engine NER dùng được trên web.');
        if (engines.some(engine => !ENGINES[engine].local) && typeof options.request !== 'function') {
            throw new Error('Thiếu hàm gửi request NER.');
        }

        const tasks = [];
        const corpusParts = [];
        chapters.forEach(chapter => {
            corpusParts.push(chapter.text);
            splitText(chapter.text, options.maxCharsPerRequest).forEach((text, chunkIndex) => {
                engines.forEach(engine => tasks.push({ chapter, chunkIndex, engine, text }));
            });
        });
        const allEntities = [];
        const warningMap = new Map();
        const requestedGap = Number(options.requestGapMs);
        const requestedRetries = Number(options.retryCount);
        const requestGapMs = Math.max(0, Number.isFinite(requestedGap) ? requestedGap : 300);
        const retryCount = Math.max(0, Math.min(3, Number.isFinite(requestedRetries) ? requestedRetries : 1));
        let completed = 0;
        let lastRequestAt = 0;
        for (const task of tasks) {
            throwIfAborted(options.signal);
            try {
                if (task.engine === 'lac') {
                    const response = await options.localAnalyze(task.text, {
                        signal: options.signal,
                        onProgress: progress => options.onEngineProgress?.({
                            ...progress,
                            chapterIndex: task.chapter.index,
                            chapterTitle: task.chapter.title,
                            engine: task.engine
                        })
                    });
                    allEntities.push(...parseLacOutput(response));
                } else {
                    const elapsed = Date.now() - lastRequestAt;
                    if (lastRequestAt && elapsed < requestGapMs) await wait(requestGapMs - elapsed, options.signal);
                    const adapter = getAdapter(task.engine);
                    const spec = adapter.makeRequest(task.text);
                    lastRequestAt = Date.now();
                    const response = await requestWithRetry(options.request, spec, options.signal, retryCount);
                    allEntities.push(...adapter.parse(response));
                }
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                const current = warningMap.get(task.engine) || { engine: task.engine, count: 0, message: '' };
                current.count++;
                current.message = error?.message || String(error);
                warningMap.set(task.engine, current);
            }
            completed++;
            options.onProgress?.({
                completed,
                total: tasks.length,
                chapterIndex: task.chapter.index,
                chapterTitle: task.chapter.title,
                engine: task.engine
            });
        }
        const warnings = Array.from(warningMap.values());
        if (!allEntities.length && warnings.length) {
            const detail = warnings.map(item => `${ENGINES[item.engine]?.label || item.engine}: ${item.message}`).join('; ');
            throw new Error(`Không engine nào trả kết quả. ${detail}`);
        }
        return {
            results: mergeEntities(allEntities, corpusParts.join('\n'), options),
            warnings,
            stats: { requests: tasks.length, completed, entities: allEntities.length }
        };
    }

    return Object.freeze({
        VERSION,
        TYPES,
        ENGINES,
        normalizeInput,
        splitText,
        normalizeType,
        makeTexSmartRequest,
        makeIbmRequest,
        parseTexSmart,
        parseIbm,
        parseLacOutput,
        mergeEntities,
        analyze
    });
});
