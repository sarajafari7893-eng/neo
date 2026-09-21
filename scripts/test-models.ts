// DEV UTILITY — probe which chat `model` ids the platform accepts (one cheap
// call each). Used to decide whether the AI core can run on a smarter model.
import ZAI from "z-ai-web-dev-sdk";

const CANDIDATES = ["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-plus", "glm-4.5-flash"];

const zai = await ZAI.create();
for (const model of CANDIDATES) {
  try {
    const res = await zai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      thinking: { type: "disabled" },
    });
    const content = res?.choices?.[0]?.message?.content ?? "";
    console.log(`MODEL ${model}: OK — "${String(content).slice(0, 40).replace(/\n/g, " ")}"`);
  } catch (err) {
    console.log(`MODEL ${model}: FAIL — ${String(err).slice(0, 140).replace(/\n/g, " ")}`);
  }
}
process.exit(0);
