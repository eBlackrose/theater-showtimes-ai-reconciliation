import { resetDemo } from "~/server/db/seed";
import { run } from "./_db";

await run(async (db) => {
  await resetDemo(db, process.env.DB_SCHEMA ?? "ronnie_takehome");
  console.log(`schema ${db.schema}: reset to the demo seed`);
});
