/** Gemini-shaped response so the frontend and history save keep working unchanged. */
export function wrapAsGeminiResponse(text: string): unknown {
    return {
        candidates: [
            {
                content: {
                    parts: [{ text }],
                },
            },
        ],
    };
}
