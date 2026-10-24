import { Project } from '@revcut/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, messageOf, noContent } from './api';

function summary(project: Project): string {
  const { total, processing, failed } = project.mediaCounts;
  const parts = [`${total} 個素材`];
  if (processing > 0) parts.push(`${processing} 個處理中`);
  if (failed > 0) parts.push(`${failed} 個失敗`);
  return parts.join(' · ');
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api(Project.array(), '/api/projects'),
    refetchInterval: (query) => (query.state.data?.some((p) => p.mediaCounts.processing > 0) ? 2000 : false),
  });

  const create = useMutation({
    mutationFn: (newTitle: string) => api(Project, '/api/projects', { method: 'POST', body: { title: newTitle } }),
    onSuccess: (project) => navigate(`/projects/${project.id}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(noContent, `/api/projects/${id}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim()) create.mutate(title.trim());
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">專案</h1>
      <form onSubmit={submit} className="mb-8 flex gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="專案名稱，例如「2026 秋天」"
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2"
        />
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        >
          新增專案
        </button>
      </form>
      {create.isError && <p className="mb-4 text-red-700">無法建立專案：{messageOf(create.error)}</p>}
      {remove.isError && <p className="mb-4 text-red-700">無法刪除專案：{messageOf(remove.error)}</p>}

      {projects.isPending && <p className="text-slate-500">載入中…</p>}
      {projects.isError && <p className="text-red-700">無法載入專案：{messageOf(projects.error)}</p>}
      {projects.data?.length === 0 && <p className="text-slate-500">還沒有專案。</p>}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {projects.data?.map((project) => (
          <li key={project.id} className="flex items-center gap-4 p-4">
            <Link to={`/projects/${project.id}`} className="min-w-0 flex-1">
              <div className="font-medium">{project.title}</div>
              <div className="text-sm text-slate-600">
                {project.dateRange ? `${project.dateRange.from} – ${project.dateRange.to} · ` : ''}
                {summary(project)}
              </div>
            </Link>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`刪除「${project.title}」和它的所有檔案？`)) remove.mutate(project.id);
              }}
              className="text-sm text-slate-500 hover:text-red-700"
            >
              刪除
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
