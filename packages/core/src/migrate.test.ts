import { describe, expect, it } from "vitest";
import { orderMigrations } from "./migrate.js";

describe("orderMigrations", () => {
  it("sorts migration files by numeric prefix", () => {
    expect(
      orderMigrations(["0010_b.sql", "0002_a.sql", "0001_init.sql"]),
    ).toEqual(["0001_init.sql", "0002_a.sql", "0010_b.sql"]);
  });

  it("ignores files that are not SQL", () => {
    expect(orderMigrations(["0001_init.sql", "notes.txt"])).toEqual([
      "0001_init.sql",
    ]);
  });

  it("rejects a SQL file with no numeric prefix", () => {
    expect(() => orderMigrations(["init.sql"])).toThrow(/init\.sql/);
  });

  it("rejects two migrations with the same number", () => {
    expect(() => orderMigrations(["0001_a.sql", "0001_b.sql"])).toThrow(/0001/);
  });
});
