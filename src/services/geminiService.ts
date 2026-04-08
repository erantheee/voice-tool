import { GoogleGenAI } from "@google/genai";
import { AudioRecord, TranscriptItem } from "../types";

let aiInstance: GoogleGenAI | null = null;

function getAI() {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

export async function analyzeAudioContent(transcript: TranscriptItem[]): Promise<{ summary: string; analysis: string }> {
  if (!transcript || transcript.length === 0) {
    return {
      summary: "无录音内容",
      analysis: "未检测到有效的对话或独白内容，无法生成分析。"
    };
  }

  const text = transcript.map(item => `${item.speaker}: ${item.text}`).join('\n');
  
  try {
    const ai = getAI();
    const prompt = `
      你是一个专业的个人生活记录助手。请对以下对话/独白进行总结和复盘分析。
      记录内容：
      ${text}
      
      请提供：
      1. 核心内容总结（简练）。
      2. 深度复盘分析（包括情绪、决策信息、重要观点等）。
      
      请以 JSON 格式返回，格式如下：
      {
        "summary": "...",
        "analysis": "..."
      }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const result = JSON.parse(response.text || '{}');
    return {
      summary: result.summary || "无总结",
      analysis: result.analysis || "无分析"
    };
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return {
      summary: "分析失败",
      analysis: error instanceof Error ? error.message : "无法生成分析内容"
    };
  }
}

export async function shouldStartRecording(
  recentAudioFeatures: { duration: number; text: string }
): Promise<boolean> {
  try {
    const ai = getAI();
    const prompt = `
      判断是否应该开启正式记录。
      当前片段信息：
      - 时长: ${recentAudioFeatures.duration}s
      - 内容: "${recentAudioFeatures.text}"
      
      原则：
      - 短时无意义发声、零散插话、单句回应不触发。
      - 持续表达、完整语义片段、带情绪或决策信息的内容应触发。
      
      请返回 JSON: { "shouldStart": boolean }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });
    const result = JSON.parse(response.text || '{}');
    return !!result.shouldStart;
  } catch (error) {
    return recentAudioFeatures.duration > 3; // 降级方案
  }
}
