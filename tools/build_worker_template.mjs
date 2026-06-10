import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const templatesDir = path.join(rootDir, "templates");
const outputPath = path.join(templatesDir, "Mau_nhap_danh_sach_cong_nhan.xlsx");

await fs.mkdir(templatesDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Danh sach CBCNV");

sheet.getRange("A1:D1").values = [["Số thứ tự", "Họ và tên", "Bộ phận", "Số điện thoại"]];
sheet.getRange("A2:D4").values = [
  [1, "Nguyễn Văn A", "May 1", "0901000001"],
  [2, "Trần Thị B", "May 2", "0901000002"],
  [3, "Lê Văn C", "Cơ điện", "0901000003"],
];

const header = sheet.getRange("A1:D1");
header.format.fill = "#176B87";
header.format.font = { bold: true, color: "#FFFFFF" };
header.format.horizontalAlignment = "center";

sheet.getRange("A1:D4").format.borders = { preset: "all", style: "thin", color: "#D9E0EA" };
sheet.getRange("A:D").format.columnWidthPx = 170;
sheet.getRange("D:D").format.numberFormat = "@";
sheet.getRange("A1:D4").format.rowHeightPx = 26;

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
