import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ExamSummary } from '@boen/shared';
import { listExams, deleteExam as apiDeleteExam } from '@/services/chat';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import type { Subject } from './chat';
import { useUiStore } from './ui';
import { SUBJECT_MAP } from './chat';

export const useExamStore = defineStore('exam', () => {
  const toast = useToast();
  const { confirm } = useConfirm();

  // ── State ─────────────────────────────────────────────────
  const exams = ref<ExamSummary[]>([]);
  const selectedExamId = ref<string | null>(null);
  const examViewKey = ref(0);
  const pendingExamNotes = ref<string | null>(null);

  // ── Actions ───────────────────────────────────────────────

  async function loadExams() {
    try {
      const { exams: list } = await listExams();
      exams.value = list;
    } catch (e) {
      console.warn('[boen] loadExams failed:', e);
    }
  }

  function startNewExam() {
    selectedExamId.value = null;
    examViewKey.value++;
  }

  function openExamReview(examId: string) {
    selectedExamId.value = examId;
  }

  function handleExam(detail: { subject: Subject; grade: string; durationMinutes: number; notes: string }) {
    const uiStore = useUiStore();
    pendingExamNotes.value = detail.notes;
    uiStore.subject = detail.subject;
    startNewExam();
  }

  async function handleDeleteExam(examId: string, event: Event) {
    event.stopPropagation();
    const ok = await confirm({ title: '\u5220\u9664\u8003\u8bd5', message: '\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u573a\u8003\u8bd5\u5417\uff1f\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\u3002', confirmText: '\u5220\u9664', danger: true });
    if (!ok) return;
    try {
      await apiDeleteExam(examId);
      exams.value = exams.value.filter((e) => e.examId !== examId);
      if (selectedExamId.value === examId) {
        selectedExamId.value = null;
      }
      toast.success('\u8003\u8bd5\u5df2\u5220\u9664');
    } catch {
      toast.error('\u5220\u9664\u8003\u8bd5\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');
    }
  }

  return {
    exams,
    selectedExamId,
    examViewKey,
    pendingExamNotes,
    loadExams,
    startNewExam,
    openExamReview,
    handleExam,
    handleDeleteExam,
  };
});

// Re-export helpers used in templates
export function subjectMeta(s: string) {
  return SUBJECT_MAP[s] ?? { label: s, emoji: '\ud83d\udcc1' };
}

export function examGradeLabel(g: string): string {
  const n = Number(g);
  if (!n) return g;
  return n <= 6 ? `\u5c0f${'\u4e00\u4e8c\u4e09\u56db\u4e94\u516d'[n - 1]}` : `\u521d${'\u4e00\u4e8c\u4e09'[n - 7]}`;
}
