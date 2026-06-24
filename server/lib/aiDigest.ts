import { getAiClient, getAiModel } from '../ai/index.js';

export async function generateDailyDigest(c: any, cycleData: any) {
  try {
    const ai = await getAiClient(c);
    const model = await getAiModel(c);

    const { recommend, resolved, aggregate, credibility } = cycleData;
    
    // Prepare the context for the prompt
    const context = `
Date: ${recommend.today || new Date().toISOString().slice(0, 10)}
Market Regime: ${recommend.timing?.regimeLabel || 'Unknown'}
Total Stocks Analyzed: ${recommend.analyzed || 0}
Total Buy Signals Detected: ${recommend.buySignals || 0}
Top Recommended Stocks: ${JSON.stringify(recommend.picks || [])}
Resolved Trades Summary: ${JSON.stringify(resolved || {})}
    `;

    const prompt = `
You are a top-tier quantitative hedge fund manager and A-share veteran. 
Based on the following data from our proprietary multi-cycle resonance and continuous-scoring engine, write a concise daily market digest (around 300-500 words) in Chinese.
Do not just list the data. Provide an analytical narrative. Explain *why* the market regime dictated the current strictness of the signals, and give a brief fundamental or technical color on the top 1-2 recommended stocks if any were found. If 0 stocks were recommended, explain that the system is protecting capital due to lack of high-conviction setups.

Data Context:
${context}
    `;

    const completion = await ai.chat.completions.create({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'Unable to generate digest.';
  } catch (error: any) {
    console.error('AI Digest error:', error);
    return `AI Digest generation failed: ${error.message}. Please check your API key in Settings.`;
  }
}
