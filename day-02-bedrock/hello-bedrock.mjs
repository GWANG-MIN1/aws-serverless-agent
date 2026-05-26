import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// AWS CLI에 설정된 credentials/region 자동 사용 (~/.aws/credentials, ~/.aws/config)
const client = new BedrockRuntimeClient({ region: "us-east-1" });

// Bedrock 콘솔 "Model catalog"에서 확인한 inference profile ID
// Global = 여러 리전에서 자동 라우팅, Haiku 4.5 = 가장 저렴한 최신 Claude
const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

console.log(`🤖 Calling ${MODEL_ID}...\n`);

const response = await client.send(
  new ConverseCommand({
    modelId: MODEL_ID,
    messages: [
      {
        role: "user",
        content: [
          {
            text: "AWS Bedrock에서 너를 처음 호출해봤어! 축하 메시지 한국어로 두 문장만 짧게 부탁해.",
          },
        ],
      },
    ],
    inferenceConfig: {
      maxTokens: 200,
      temperature: 0.7,
    },
  })
);

const reply = response.output.message.content[0].text;
console.log("📝 Claude 응답:");
console.log(reply);

console.log("\n--- 토큰 사용량 ---");
console.log(`입력: ${response.usage.inputTokens} tokens`);
console.log(`출력: ${response.usage.outputTokens} tokens`);
console.log(`총합: ${response.usage.totalTokens} tokens`);

// Haiku 4.5 가격 (2026년 기준): input $1/M, output $5/M
const inputCost = (response.usage.inputTokens / 1_000_000) * 1.0;
const outputCost = (response.usage.outputTokens / 1_000_000) * 5.0;
console.log(`예상 비용: $${(inputCost + outputCost).toFixed(6)} (약 ${Math.round((inputCost + outputCost) * 1380 * 1000) / 1000}원)`);
