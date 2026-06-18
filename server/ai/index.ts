import OpenAI from 'openai';
import { getDb } from '../db/getDb.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function getAiClient(c?: any) {
  const dbSettings = await getDb(c).select().from(settings).all();
  const config: Record<string, string> = {};
  for (const s of dbSettings) {
    config[s.key] = s.value;
  }

  const baseURL = config['ai_base_url'] || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = config['ai_api_key'] || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || '';
  
  if (!apiKey) {
    throw new Error('API Key is not configured. Please configure it in settings.');
  }

  return new OpenAI({
    baseURL,
    apiKey,
  });
}

export async function getAiModel(c?: any) {
  const modelSetting = await getDb(c).select().from(settings).where(eq(settings.key, 'ai_model')).get();
  return modelSetting?.value || 'gpt-4o-mini';
}

export async function getAiPrompt(key: string, defaultPrompt: string, c?: any) {
  const promptSetting = await getDb(c).select().from(settings).where(eq(settings.key, key)).get();
  return promptSetting?.value || defaultPrompt;
}
