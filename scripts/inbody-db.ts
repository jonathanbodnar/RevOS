import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const total = await prisma.inBodyTest.count();
  console.log("InBodyTest rows:", total);
  const rows = await prisma.inBodyTest.groupBy({
    by: ["account"],
    _count: { _all: true },
  });
  console.log("accounts:", JSON.stringify(rows));
  const recent = await prisma.inBodyTest.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      account: true,
      deviceType: true,
      resultStatus: true,
      matchStatus: true,
      fetchError: true,
      createdAt: true,
    },
  });
  console.log("recent:", JSON.stringify(recent, null, 2));
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
