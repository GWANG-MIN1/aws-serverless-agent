// AWS Lambda 핸들러 — 가장 단순한 hello world
// event: 호출자가 보낸 입력 (JSON 객체)
// context: Lambda 런타임 정보 (함수 이름, 메모리, 남은 시간 등)
export const handler = async (event, context) => {
  console.log("Event received:", JSON.stringify(event));
  console.log("Function name:", context.functionName);
  console.log("Remaining time (ms):", context.getRemainingTimeInMillis());

  const name = event?.name ?? "World";

  return {
    statusCode: 200,
    message: `Hello, ${name}! From AWS Lambda 🚀`,
    functionName: context.functionName,
    region: process.env.AWS_REGION,
    timestamp: new Date().toISOString(),
  };
};
