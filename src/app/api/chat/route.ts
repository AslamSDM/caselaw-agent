import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { llmConfigured, model, reasoningEffort } from "@/lib/llm";
import { chatInstructions, chatTools, scopeContext } from "@/lib/chat/agent";
import { CHAT_ID, saveChat } from "@/lib/chat/store";

export const maxDuration = 300;

const body = z.object({
  /** chat id from useChat; the conversation is saved under it */
  id: z.string().regex(CHAT_ID).optional(),
  messages: z.array(z.any()).min(1).max(60),
  searchId: z.number().int().positive().nullish(),
  caseUri: z.string().max(200).nullish(),
});

/** Follow-up chat about a search's results or one judgment; streams UI messages and saves the chat. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  if (!llmConfigured()) return Response.json({ error: "No LLM configured" }, { status: 500 });
  const { id, searchId, caseUri } = parsed.data;
  const messages = parsed.data.messages as UIMessage[];

  const context = await scopeContext({ searchId: searchId ?? undefined, caseUri: caseUri ?? undefined });
  const effort = reasoningEffort("strong");
  const result = streamText({
    model: model("strong"),
    instructions: chatInstructions(context),
    messages: await convertToModelMessages(messages),
    tools: chatTools(req.signal),
    stopWhen: isStepCount(8),
    abortSignal: req.signal,
    providerOptions: effort && process.env.OPENROUTER_API_KEY ? { openrouter: { reasoning: { effort } } } : undefined,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onEnd: async ({ messages: all }) => {
        if (!id) return;
        await saveChat(id, { searchId, caseUri }, all).catch((err) => console.error("[chat] save failed:", err));
      },
      onError: (err) => (err instanceof Error ? err.message : String(err)),
    }),
  });
}
