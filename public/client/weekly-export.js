import { isAdminRole } from './roles.js';
import { sanitizeStateForActor } from './access.js';
import { addDays, progressAgainstPlan } from './domain.js';
import { datePart, deadlineMs, formatDateTime, isOverdue } from './time.js';

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const STATUS = { todo: '未开始', doing: '进行中', review: '待验收', done: '已完成' };
const xml = value => String(value ?? '').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ordered = items => items.slice().sort((a, b) => deadlineMs(a.dueDate) - deadlineMs(b.dueDate) || String(a.id).localeCompare(String(b.id)));

/** A report is a current-state snapshot of the same due-date cohort as the weekly page. */
export function buildWeeklyReport(state, { actorId, range, now = Date.now() } = {}) {
  const scoped = sanitizeStateForActor(state, actorId);
  if (!range || !/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end) || addDays(range.start, 6) !== range.end) throw new Error('请选择有效的一周');
  if (!Number.isFinite(now)) throw new Error('导出时间无效');
  const actor = scoped.users.find(item => item.id === actorId);
  const projects = new Map(scoped.projects.map(item => [item.id, item]));
  const users = new Map(scoped.users.map(item => [item.id, item]));
  const inRange = (item, window) => { const day = datePart(item.dueDate); return day && day >= window.start && day <= window.end; };
  const tasks = ordered(scoped.tasks.filter(item => inRange(item, range)));
  const milestones = ordered(scoped.milestones.filter(item => inRange(item, range)));
  const nextRange = { start: addDays(range.start, 7), end: addDays(range.end, 7) };
  const next = ordered(scoped.tasks.filter(item => inRange(item, nextRange)));
  const done = tasks.filter(item => item.status === 'done').length;
  const late = tasks.filter(item => item.status !== 'done' && isOverdue(item.dueDate, now)).length;
  const taskRows = items => items.map(item => [item.title, projects.get(item.projectId)?.name || '—', users.get(item.ownerId)?.name || '未分配', `${STATUS[item.status] || item.status}${item.status !== 'done' && isOverdue(item.dueDate, now) ? ' · 已逾期' : ''}`, formatDateTime(item.dueDate), formatDateTime(item.submittedAt), formatDateTime(item.reviewedAt), item.deliverable || '—']);
  const stageSignatures = milestone => {
    if(milestone.status==='done'&&!milestone.signatures?.length)return '已达成（历史记录）';
    const primary=projects.get(milestone.projectId)?.ownerId;
    const seats=[['owner','主验',primary],...(milestone.coReviewerId?[['coReviewer','加验',milestone.coReviewerId]]:[])];
    return seats.map(([position,label,expected])=>{
      const signature=milestone.signatures?.find(item=>item.as===position);
      return signature?`${label} ${users.get(signature.actorId)?.name||'—'} 已签 ${formatDateTime(signature.at)}`:`${label} ${users.get(expected)?.name||'—'} 待签`;
    }).join(' / ');
  };
  const taskColumns = ['任务', '项目', '负责人', '状态', '截止时间', '提交时间', '验收 / 审核时间', '交付成果'];
  const taskWidths = [34, 26, 14, 20, 23, 23, 23, 42];
  return {
    title: '鼎峰项目周报', range: { ...range }, generatedAt: formatDateTime(new Date(now).toISOString()),
    scope: isAdminRole(actor.role) ? '全部项目' : `${actor.name}参与的项目`,
    tables: [
      { title: '本周概况', headers: ['指标', '数量'], widths: [28, 20], rows: [['本周到期任务', tasks.length], ['已验收完成', done], ['未完成任务', tasks.length - done], ['逾期任务', late], ['本周大节点', milestones.length], ['已达成大节点', milestones.filter(item => item.status === 'done').length]] },
      { title: '项目进度', headers: ['项目', '负责人', '任务总数', '已验收完成', '任务完成率', '项目截止时间'], widths: [38, 16, 16, 18, 18, 24], percentColumns: [4], rows: scoped.projects.map(item => { const progress = progressAgainstPlan(scoped.tasks.filter(task => task.projectId === item.id), now); return [item.name, users.get(item.ownerId)?.name || '未分配', progress.total, progress.completed, progress.total ? progress.actual / 100 : '—', formatDateTime(item.dueDate)]; }) },
      { title: '本周任务', headers: taskColumns, widths: taskWidths, rows: taskRows(tasks) },
      { title: '本周大节点', headers: ['节点', '项目', '状态', '截止时间', '达成时间', '已验收任务', '任务总数', '阶段签字'], widths: [36, 30, 20, 23, 23, 18, 16, 42], rows: milestones.map(item => { const related = scoped.tasks.filter(task => task.milestoneId === item.id); return [item.title, projects.get(item.projectId)?.name || '—', item.status === 'done' ? '已达成' : isOverdue(item.dueDate, now) ? '未达成 · 已逾期' : '未达成', formatDateTime(item.dueDate), formatDateTime(item.acceptedAt), related.filter(task => task.status === 'done').length, related.length, stageSignatures(item)]; }) },
      { title: '下周计划', headers: taskColumns, widths: taskWidths, rows: taskRows(next) },
    ],
  };
}

// Stored ZIP entries keep browser exports dependency-free and usable offline.
const utf8 = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function join(parts) { const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = utf8.encode(path), data = utf8.encode(declaration + value), crc = crc32(data);
    const header = new Uint8Array(30), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 33, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    const directory = new Uint8Array(46), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true); d.setUint16(14, 33, true);
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = join(central), end = new Uint8Array(22), e = new DataView(end.buffer), count = Object.keys(entries).length;
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true); e.setUint32(12, directory.length, true); e.setUint32(16, offset, true);
  return join([...local, directory, end]);
}

const packageNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = items => `<Relationships xmlns="${packageNS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeNS}/${type}" Target="${xml(target)}"/>`).join('')}</Relationships>`;
const contentTypes = parts => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts.map(([path, type]) => `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('')}</Types>`;
function columnName(index) { let name = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name; return name; }
function cell(value, row, col, style = 0) {
  const address = `${columnName(col)}${row}`;
  return typeof value === 'number' && Number.isFinite(value)
    ? `<c r="${address}" s="${style}"><v>${value}</v></c>`
    : `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}
function worksheet(report, table) {
  const lastColumn = columnName(table.headers.length - 1);
  const body = table.rows.length ? table.rows : [['暂无记录']];
  const rows = [
    `<row r="1" ht="30" customHeight="1">${cell(`${report.title} ${table.title}`, 1, 0, 1)}</row>`,
    `<row r="2" ht="36" customHeight="1">${cell(`${report.range.start} 至 ${report.range.end}　${report.scope}`, 2, 0, 4)}</row>`,
    `<row r="3" ht="42" customHeight="1">${cell(`导出时间 ${report.generatedAt}（北京时间）　按截止日期统计，项目进度为当前快照`, 3, 0, 4)}</row>`,
    `<row r="5" ht="28" customHeight="1">${table.headers.map((value, index) => cell(value, 5, index, 2)).join('')}</row>`,
    ...body.map((values, index) => {
      const lines = Math.max(...values.map((value, col) => Math.ceil(String(value ?? '').length * 1.7 / table.widths[col]) + String(value ?? '').split('\n').length - 1));
      return `<row r="${index + 6}" ht="${Math.min(409, Math.max(30, lines * 15 + 12))}" customHeight="1">${values.map((value, col) => cell(value, index + 6, col, table.percentColumns?.includes(col) ? 3 : 0)).join('')}</row>`;
    }),
  ];
  return `<worksheet xmlns="${sheetNS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastColumn}${body.length + 5}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${table.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData>${table.rows.length ? `<autoFilter ref="A5:${lastColumn}${body.length + 5}"/>` : ''}<mergeCells count="3">${[1, 2, 3].map(row => `<mergeCell ref="A${row}:${lastColumn}${row}"/>`).join('')}</mergeCells><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
function xlsx(report) {
  const sheets = report.tables;
  const entries = {
    '[Content_Types].xml': contentTypes([['xl/workbook.xml', 'spreadsheetml.sheet.main'], ['xl/styles.xml', 'spreadsheetml.styles'], ...sheets.map((_, index) => [`xl/worksheets/sheet${index + 1}.xml`, 'spreadsheetml.worksheet'])]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook xmlns="${sheetNS}" xmlns:r="${officeNS}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.title)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([...sheets.map((_, index) => [`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`]), ['rIdStyles', 'styles', 'styles.xml']]),
    'xl/styles.xml': `<styleSheet xmlns="${sheetNS}"><fonts count="4"><font><sz val="11"/><name val="等线"/><color rgb="FF242C35"/></font><font><b/><sz val="18"/><name val="等线"/></font><font><b/><sz val="11"/><name val="等线"/><color rgb="FFFFFFFF"/></font><font><sz val="10"/><name val="等线"/><color rgb="FF626C78"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF334F68"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  sheets.forEach((sheet, index) => { entries[`xl/worksheets/sheet${index + 1}.xml`] = worksheet(report, sheet); });
  return zip(entries);
}

function paragraph(value, style = 'Normal') { return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${String(value ?? '').split('\n').map((line, index) => `<w:r>${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('')}</w:p>`; }
function wordTable(table) {
  const total = table.widths.reduce((sum, width) => sum + width, 0), available = 15398;
  const widths = table.widths.map(width => Math.floor(width / total * available));
  widths[widths.length - 1] += available - widths.reduce((sum, width) => sum + width, 0);
  const rows = table.rows.length ? table.rows : [table.headers.map((_, index) => index ? '' : '暂无记录')];
  const row = (values, header = false) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${values.map((value, index) => `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:fill="E9EEF3"/>' : ''}<w:vAlign w:val="top"/></w:tcPr>${paragraph(!header && table.percentColumns?.includes(index) && typeof value === 'number' ? `${Math.round(value * 100)}%` : value, header ? 'TableHeader' : 'TableBody')}</w:tc>`).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${available}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="D5DDE5"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${row(table.headers, true)}${rows.map(values => row(values)).join('')}</w:tbl>${paragraph('')}`;
}
function docx(report) {
  return zip({
    '[Content_Types].xml': contentTypes([['word/document.xml', 'wordprocessingml.document.main'], ['word/styles.xml', 'wordprocessingml.styles'], ['word/footer1.xml', 'wordprocessingml.footer']]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/_rels/document.xml.rels': relationships([['rIdStyles', 'styles', 'styles.xml'], ['rIdFooter', 'footer', 'footer1.xml']]),
    'word/document.xml': `<w:document xmlns:w="${wordNS}" xmlns:r="${officeNS}"><w:body>${paragraph(report.title, 'Title')}${paragraph(`${report.range.start} 至 ${report.range.end}　${report.scope}`)}${paragraph(`按截止日期汇总所选周任务与节点，项目进度为当前快照。导出时间 ${report.generatedAt}，时间均为北京时间。`)}${report.tables.map(table => paragraph(table.title, 'Heading1') + wordTable(table)).join('')}${paragraph('负责人补充', 'Heading1')}${paragraph('延期原因：')}${paragraph('需要协调的资源：')}${paragraph('下周重点：')}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<w:styles xmlns:w="${wordNS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="等线"/><w:sz w:val="20"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="260" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableBody"><w:name w:val="Table Body"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="TableBody"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
    'word/footer1.xml': `<w:ftr xmlns:w="${wordNS}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>第 </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>`,
  });
}

/** Return bytes to the existing browser download helper; no network request is made. */
export function createWeeklyExport(report, format) {
  if (!Object.hasOwn(MIME, format)) throw new Error('请选择 Excel 或 Word 格式');
  return { bytes: format === 'xlsx' ? xlsx(report) : docx(report), mime: MIME[format], filename: `鼎峰周报_${report.range.start}_${report.range.end}.${format}` };
}
