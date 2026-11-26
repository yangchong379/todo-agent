import { splitSchedule } from "./task-dates.ts";

export interface BatchItem {
  title: string;
  when?: string;
}

const record =
  /^(?:(?:能|麻烦|请)?(?:帮我|给我)?)?(?:记一下|记下|记上|记个待办|记(?:这)?几件事|添加|新增)(?:\s*[:：])?\s*/u;
const subject = /^我(?!们)\s*/u;
const order = /^(?:先|再|还要再|还得再)\s*/u;
const modal = /^(?:还)?(?:得要|得|需要|必须|打算|计划|要|记得)\s*/u;
const activity =
  /^(?:给.+?(?:打|回|发|寄|送)|把.+?(?:交|发|拿|带|整理|洗|签|寄|还|装|送|办|准备)|打(?:电话|游戏|扫|包|车|球|疫苗|印)|(?:吃|洗|取|买|交|送|接|去|拿|领|还|缴|办|寄|看|换|整理|准备|预约|检查|打印|带|签|修|回|开会|面试|培训|体检|提交|更新|复印|上课|遛|安排|参加|赶|做|录|填|确认|报销|核对|查|问|听|扫|找)\S)/u;
const standaloneActivity =
  /^(?:开会|面试|培训|体检|复诊|上课|洗澡|跑步|锻炼|游泳|购物|休息|睡觉|散步)$/u;
const appointment =
  /^(?:还有|有)(?:一?[个场次])?(?:约|会|面试|考试|体检|复诊|\S*(?:会议|例会|周会|家长会))$/u;
const dailyTime = /^(?:下班|放学|午饭|晚饭|回家)(?:前|后)\s*/u;
const uncertain =
  /^(?:昨天|前天|昨晚|刚才|刚刚|已经|如果|假如|要是|万一|可能|也许|说不定|好像|大概|要不要|是不是|不(?:用|必|会|需要|打算|想|去|做|要)|没)|(?:取消了|改期了|过了吧|来不及|没法|不能|不确定|不一定|说不准|可能|也许|不过不)/u;
const conditional = /^(?:如果|假如|要是|万一)/u;
const otherOperation =
  /^(?:(?:能不能|可以|帮我|给我|请)\s*)*(?:删除|删掉|移除|标记|完成|恢复|查看|列出)|^(?:把|将).+?(?:从(?:我的)?(?:待办|清单)|删掉|拿掉|移除|改(?:到|成|为)|标(?:记)?为)|^.+?(?:改到|推迟到|改期到|提前到).+$/u;

function startsPlan(text: string) {
  const phrase = text.trim().replace(subject, "");
  const rest = (splitSchedule(phrase)?.rest ?? phrase).replace(order, "");
  return (
    modal.test(rest) ||
    dailyTime.test(rest) ||
    record.test(rest) ||
    activity.test(rest) ||
    standaloneActivity.test(rest) ||
    appointment.test(rest)
  );
}

function splitClauses(text: string) {
  const pieces = text.split(/([，,；;。！？!?\n]|[、]|然后|顺便|接着|另外|还有|以及|并且|并|和)/u);
  const clauses = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) {
    const delimiter = pieces[i];
    const next = pieces[i + 1];
    if (!next && !/[？?]/u.test(delimiter)) continue;
    if (/[，,；;。！？!?\n]/u.test(delimiter) || startsPlan(next)) {
      if (/[？?]/u.test(delimiter)) clauses[clauses.length - 1] += delimiter;
      if (next) clauses.push(next);
    } else {
      clauses[clauses.length - 1] += delimiter + next;
    }
  }
  return clauses.map((clause) => clause.trim()).filter(Boolean);
}

export function parseBatch(text: string, isQuestion: boolean): BatchItem[] | false | undefined {
  // 仅在“见天”出现在句首的计划时间槽，且紧跟行动助词时纠正常见误输。
  const sentence = text.replace(/^(我\s*)?见天(?=\s*(?:还)?(?:要|得|需要))/u, "$1今天");
  const memo = record.exec(sentence);
  const content = memo ? sentence.slice(memo[0].length).trim() : sentence;
  if (memo && /^(?:「.*」|『.*』|“.*”|".*")$/su.test(content)) return undefined;
  const clauses = splitClauses(content);
  if (clauses.length < 2) return undefined;
  if (conditional.test(sentence.replace(subject, "")) || (isQuestion && !memo)) return false;

  const result: BatchItem[] = [];
  let day: string | undefined;
  let when: string | undefined;
  let inheritsPlan = !!memo;
  let explicitPlan = !!memo;
  let blockedContext = false;
  for (const clause of clauses) {
    if (otherOperation.test(clause)) return false;

    const request = record.exec(clause);
    const statement = (request ? clause.slice(request[0].length) : clause).replace(subject, "");
    const leadingIntent = modal.exec(statement);
    const planned = leadingIntent ? statement.slice(leadingIntent[0].length) : statement;
    const schedule = splitSchedule(planned);
    const rest = (schedule?.rest ?? planned).replace(subject, "");
    const block = dailyTime.exec(rest);
    const action = (block ? rest.slice(block[0].length) : rest).replace(order, "");
    const intention = modal.exec(action);
    const title = (intention ? action.slice(intention[0].length) : action).trim();
    if (
      [statement, rest, title].some((part) => uncertain.test(part)) ||
      /[？?]|(?:吗|么)$/u.test(title)
    ) {
      blockedContext = true;
      inheritsPlan = false;
      day = undefined;
      when = undefined;
      continue;
    }

    if (schedule) {
      day = schedule.day ?? day ?? "今天";
      when = day + (schedule.period ?? "") + (schedule.clock ?? "");
    } else if (block) {
      day ??= "今天";
      when = day;
    }

    const ownPlan = !!(memo || request || schedule || block || intention || leadingIntent);
    if (!ownPlan && (blockedContext || /(?:完了|结束了|搞定了|办妥了|好了)$/u.test(title)))
      continue;
    if (ownPlan) {
      blockedContext = false;
      explicitPlan = true;
    }
    if (!title) {
      if (ownPlan) inheritsPlan = true;
      continue;
    }
    const isActivity =
      activity.test(title) || standaloneActivity.test(title) || appointment.test(title);
    if (!isActivity && !memo && !request && !intention && !leadingIntent) {
      inheritsPlan = false;
      continue;
    }

    result.push({
      title: (block?.[0].trim() ?? "") + title,
      when: ownPlan || inheritsPlan ? when : undefined,
    });
    inheritsPlan ||= ownPlan;
  }

  return result.length > 1 || (result.length === 1 && explicitPlan) ? result : undefined;
}
