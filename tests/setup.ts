import { randomBytes, randomUUID } from "node:crypto";
process.env.MASTER_KEY = randomBytes(32).toString("base64");
process.env.APP_ORIGIN = "http://127.0.0.1:3000";
process.env.SELF_HOST = "false";
process.env.DATABASE_URL = `file:./data/unit-${process.pid}-${randomUUID()}.db`;
