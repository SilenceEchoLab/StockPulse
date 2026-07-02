// 结构化 LLM 调用层 —— 用 json_schema 强约束输出，提升对接稳定性
// 策略：优先 response_format=json_schema(strict) 强制字段齐全/类型正确；
//       provider 不支持时降级 json_object + coerceToSchema 按 schema 补默认/校正。
// 下游因此总能拿到 schema 完整对象，不再因模型"丢字段"而失效。

import { logger } from './logger.js';

export interface SchemaDef {
  name: string;
  schema: any; // 标准 JSON Schema（type/properties/required/additionalProperties:false）
}

/**
 * 结构化对话：返回符合 schema 的对象。
 * @param ai OpenAI client；@param model 模型名；@param messages 消息；@param def schema 定义
 */
export async function chatStructured(ai: any, model: string, messages: any[], def: SchemaDef, opts: { temperature?: number; useJsonSchema?: boolean } = {}): Promise<any> {
  const base: any = { model, messages, temperature: opts.temperature ?? 0.4 };
  const startTime = Date.now();
  logger.llm.request(def.name, model, { messages, schema: def.name });

  if (opts.useJsonSchema === true) {
    try {
      const r = await ai.chat.completions.create({
        ...base,
        response_format: { type: 'json_schema', json_schema: { name: def.name, schema: def.schema, strict: true } },
      });
      const result = robustParse(r.choices[0]?.message?.content, def.schema);
      logger.llm.response(def.name, Date.now() - startTime, result);
      return result;
    } catch (e: any) {
      const msg = `${e?.message || ''} ${JSON.stringify(e?.error || e?.response?.data || '')}`;
      const unsupported = e?.status === 400 || e?.status === 404 ||
        /json_schema|response_format|unsupported|invalid.{0,20}schema|unknown.*parameter/i.test(msg);
      if (!unsupported) {
        logger.llm.error(def.name, e);
        throw e;
      }
      logger.warn('LLM', `json_schema strict not supported, degrading to json_object for ${def.name}`);
      // 不支持 → 降级 json_object
    }
  }
  
  try {
    const r = await ai.chat.completions.create({ ...base, response_format: { type: 'json_object' } });
    const result = robustParse(r.choices[0]?.message?.content, def.schema);
    logger.llm.response(def.name, Date.now() - startTime, result);
    return result;
  } catch (e: any) {
    logger.llm.error(def.name, e);
    throw e;
  }
}

/** 容错解析：直解失败则抽取 {...}/[...] 块；都失败则全默认兜底（绝不抛） */
function robustParse(text: any, schema: any): any {
  if (text == null) return coerceToSchema({}, schema);
  const s = String(text).trim();
  try { return coerceToSchema(JSON.parse(s), schema); } catch { /* 继续抽取 */ }
  const m = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return coerceToSchema(JSON.parse(m[0]), schema); } catch { /* 继续 */ } }
  return coerceToSchema({}, schema);
}

/** 按 schema 补齐缺失字段 / 校正错误类型（递归） */
export function coerceToSchema(obj: any, schema: any): any {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const props = schema?.properties || {};
  const out: any = {};
  for (const k of Object.keys(props)) {
    const sub = props[k];
    if (obj[k] !== undefined && matchesType(obj[k], sub)) {
      out[k] = sub.type === 'object' && sub.properties ? coerceToSchema(obj[k], sub) : obj[k];
    } else {
      out[k] = defaultFor(sub); // 缺失或类型错 → 类型化默认
    }
  }
  return out;
}

function matchesType(v: any, sub: any): boolean {
  if (sub.type === 'integer' || sub.type === 'number') return typeof v === 'number' && isFinite(v);
  if (sub.type === 'string') return typeof v === 'string' && (!sub.enum || sub.enum.includes(v));
  if (sub.type === 'boolean') return typeof v === 'boolean';
  if (sub.type === 'object') return v != null && typeof v === 'object' && !Array.isArray(v);
  if (sub.type === 'array') return Array.isArray(v);
  return false;
}

function defaultFor(sub: any): any {
  if (sub.type === 'integer' || sub.type === 'number') return 0;
  if (sub.type === 'string') return sub.enum ? sub.enum[sub.enum.length - 1] : '';
  if (sub.type === 'boolean') return false;
  if (sub.type === 'object') return coerceToSchema({}, sub);
  if (sub.type === 'array') return [];
  return null;
}

// ── 复用 schema 定义 ──

const VALUE_AXIS = {
  type: 'object', additionalProperties: false,
  required: ['score', 'tag', 'reason'],
  properties: {
    score: { type: 'integer' },
    tag: { type: 'string', enum: ['高', '中', '低', '无'] },
    reason: { type: 'string' },
  },
};

/** AI 诊股 schema（/sentiment） */
export const SENTIMENT_SCHEMA: SchemaDef = {
  name: 'stock_sentiment',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['score', 'label', 'summary', 'diagnosis', 'investmentValue', 'speculationValue'],
    properties: {
      score: { type: 'integer' },
      label: { type: 'string' },
      summary: { type: 'string' },
      diagnosis: {
        type: 'object', additionalProperties: false,
        required: ['isWashing', 'isDistributing', 'reason'],
        properties: { isWashing: { type: 'boolean' }, isDistributing: { type: 'boolean' }, reason: { type: 'string' } },
      },
      investmentValue: VALUE_AXIS,
      speculationValue: VALUE_AXIS,
    },
  },
};

/** 反方批判 schema（多轮诊断 Round 2） */
export const CRITIQUE_SCHEMA: SchemaDef = {
  name: 'critique',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['critique', 'risks', 'confidence'],
    properties: {
      critique: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
    },
  },
};

/** 综合评估 schema（多轮诊断 Round 3） */
export const SYNTHESIS_SCHEMA: SchemaDef = {
  name: 'synthesis',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['finalScore', 'finalLabel', 'finalSummary', 'keyUncertainty'],
    properties: {
      finalScore: { type: 'integer' },
      finalLabel: { type: 'string' },
      finalSummary: { type: 'string' },
      keyUncertainty: { type: 'string' },
    },
  },
};

/** 批量排分 schema（选股锦标赛 Phase 1） */
export const BATCH_RANK_SCHEMA: SchemaDef = {
  name: 'batch_rank',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['picks'],
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['code', 'score', 'reason'],
          properties: { code: { type: 'string' }, score: { type: 'integer' }, reason: { type: 'string' } },
        },
      },
    },
  },
};

/** 选股委员会终评 schema（Phase 2） */
export const COMMITTEE_SCHEMA: SchemaDef = {
  name: 'committee',
  schema: {
    type: 'object', additionalProperties: false,
    required: ['topPicks'],
    properties: {
      topPicks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['rank', 'code', 'name', 'reason', 'investmentTag', 'speculationTag'],
          properties: {
            rank: { type: 'integer' },
            code: { type: 'string' },
            name: { type: 'string' },
            reason: { type: 'string' },
            investmentTag: { type: 'string', enum: ['高', '中', '低', '无'] },
            speculationTag: { type: 'string', enum: ['高', '中', '低', '无'] },
          },
        },
      },
    },
  },
};
