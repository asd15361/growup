import { DailyJournal, MemoryFact } from '../types';

interface IdentityContext {
  userName?: string;
  companionName?: string;
}

function detectTone(text: string): 'stress' | 'motivation' | 'neutral' {
  if (/(焦虑|压力|崩溃|烦|累|失眠|难受)/.test(text)) {
    return 'stress';
  }
  if (/(冲刺|执行|行动|突破|提升|成长|自律)/.test(text)) {
    return 'motivation';
  }
  return 'neutral';
}

function topFocus(journal: DailyJournal | null): string {
  if (!journal) return '先明确今天最重要的一件事';
  if (journal.focus.trim()) return journal.focus.trim();
  return '先完成一个可交付的小目标';
}

export function generateCoachReply(
  userInput: string,
  memories: MemoryFact[],
  journal: DailyJournal | null,
  identity?: IdentityContext,
): string {
  const tone = detectTone(userInput);
  const userName = identity?.userName?.trim() || '你';
  const companionName = identity?.companionName?.trim() || '我';
  const memoryBlock =
    memories.length === 0
      ? '我还在学习你，先从今天开始建立你的成长档案。'
      : `我记得你最近的关键信息：${memories.map((m) => m.value).join('；')}`;

  const focus = topFocus(journal);

  if (tone === 'stress') {
    return [
      `${userName}，我是${companionName}。收到，你现在压力比较高，我们先稳住节奏。`,
      memoryBlock,
      `今天只做 3 件事：1) ${focus} 2) 处理一个最紧急事项 3) 晚上做 10 分钟复盘。`,
      `你先告诉我：现在最卡住你的具体点是什么？${companionName}帮你拆成下一步。`,
    ].join('\n');
  }

  if (tone === 'motivation') {
    return [
      `${userName}，我是${companionName}。这个状态很好，我们把冲劲转成结果。`,
      memoryBlock,
      `执行清单：1) 锁定主线目标（${focus}） 2) 给它 2 个 25 分钟专注块 3) 结束后给我回报结果。`,
      '你现在就选第一步，我帮你盯进度。',
    ].join('\n');
  }

  return [
    `${userName}，我是${companionName}，我在。`,
    memoryBlock,
    `今天你的主线可以先放在：${focus}`,
    '如果你愿意，我可以马上给你生成“今天最重要 3 件事”。',
  ].join('\n');
}

export function buildJournalRecordedReply(summary: string): string {
  return `我已经帮你记录今天的成长日志。\n今日摘要：${summary}\n晚上我会再提醒你复盘结果。`;
}
