import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/** Replace every delegate with a stub that fails unless explicitly mocked. */
export function isolatePrisma(): () => void {
  const originals: Record<string, unknown> = {};
  const operations = ["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy"];
  for (const model of Object.values(Prisma.ModelName)) {
    const key = model[0].toLowerCase() + model.slice(1);
    originals[key] = Reflect.get(prisma, key);
    const stub = Object.fromEntries(operations.map((operation) => [operation, () => {
      throw new Error(`Unexpected database call: ${key}.${operation}`);
    }]));
    Reflect.set(prisma, key, stub);
  }
  // Interactive transactions must also be explicitly mocked to run in memory.
  for (const key of ["$transaction", "$connect", "$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]) {
    originals[key] = Reflect.get(prisma, key);
    Reflect.set(prisma, key, () => { throw new Error(`Unexpected database call: ${key}`); });
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) Reflect.set(prisma, key, value);
  };
}
