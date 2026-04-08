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

export async function analyzeAudioContent(
  transcript: TranscriptItem[],
  audioBase64?: string,
  mimeType?: string
): Promise<{ 
  summary: string; 
  analysis: string;
  refinedTranscript?: TranscriptItem[];
}> {
  if (!transcript || transcript.length === 0) {
    return {
      summary: "无录音内容",
      analysis: "未检测到有效的对话或独白内容，无法生成分析。"
    };
  }

  const text = transcript.map((item, i) => `[${i}] ${item.speaker}: ${item.text}`).join('\n');
  
  try {
    const ai = getAI();

    const prompt = `
      你是一个专业的个人生活记录助手。请结合提供的音频（如果有）和初步转写文本，进行总结、复盘分析，并优化说话人识别。
      
      初步转写文本（格式：[索引] 说话人: 内容）：
      ${text}
      
      任务要求：
      1. **核心内容总结**：简练概括对话或独白的主旨。
      2. **深度复盘分析**：分析情绪、决策信息、重要观点。特别注意识别由于口音或环境噪音可能导致的转写错误。
      3. **优化说话人识别与转写**：
         - 基于音频和上下文逻辑，修正初步转写中的错误（特别是带口音的词汇）。
         - 准确区分“me”（我）和“other”（他人/关注人）。
         - 识别并标注环境音（如：[背景杂音]、[笑声]、[汽车鸣笛]），如果它们影响了对话背景。
      
      请以 JSON 格式返回，格式如下：
      {
        "summary": "...",
        "analysis": "...",
        "refinedTranscript": [
          { "speaker": "me" | "other" | "person_id", "text": "...", "timestamp": ... },
          ...
        ]
      }
      注意：refinedTranscript 必须包含所有对话片段。如果音频中包含环境音，请在 text 中用方括号标注。
    `;

    const parts: any[] = [{ text: prompt }];
    
    if (audioBase64 && mimeType) {
      parts.push({
        inlineData: {
          mimeType: mimeType.includes('mp4') ? 'audio/mp4' : 'audio/webm',
          data: audioBase64
        }
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: { parts },
      config: {
        responseMimeType: "application/json"
      }
    });

    const parsedResult = JSON.parse(response.text || '{}');
    
    // Merge timestamps back if Gemini missed them
    const refined = parsedResult.refinedTranscript?.map((item: any, i: number) => ({
      ...item,
      timestamp: transcript[i]?.timestamp || Date.now()
    }));

    return {
      summary: parsedResult.summary || "无总结",
      analysis: parsedResult.analysis || "无分析",
      refinedTranscript: refined
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
