// DynamoDB CRUD Lambda
// 같은 함수로 action=create / read / list 3가지 동작 처리
// 환경변수 TABLE_NAME 은 CDK가 자동 주입

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

// DocumentClient: marshalling 자동 처리 (JS 객체 ↔ DDB AttributeValue)
// 안 쓰면 {S: "...", N: "..."} 같이 타입 일일이 적어야 함
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));
  const action = event?.action;

  try {
    switch (action) {
      case "create": {
        const id = randomUUID();
        const item = {
          id,
          title: event.title ?? "untitled",
          body: event.body ?? "",
          createdAt: new Date().toISOString(),
        };
        await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
        return { ok: true, action: "create", item };
      }

      case "read": {
        if (!event.id) throw new Error("id is required for read");
        const res = await ddb.send(
          new GetCommand({ TableName: TABLE, Key: { id: event.id } })
        );
        return { ok: true, action: "read", item: res.Item ?? null };
      }

      case "list": {
        // 학습용 — 실서비스에서 Scan은 비싸므로 금기. Query/GSI 써야 함.
        const res = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 20 }));
        return { ok: true, action: "list", count: res.Count, items: res.Items };
      }

      default:
        return {
          ok: false,
          error: `Unknown action: '${action}'. Use 'create' | 'read' | 'list'`,
        };
    }
  } catch (err) {
    console.error("Handler error:", err);
    return { ok: false, error: err.message, stack: err.stack };
  }
};
