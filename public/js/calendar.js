// calendar.js — Client-side month grid rendering for /calendar
let currentDate = new Date();

function renderCalendar() {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const monthTitle = document.getElementById('calendarMonthTitle');
  if (monthTitle) {
    monthTitle.textContent = `${monthNames[month]} ${year}`;
  }

  const daysGrid = document.getElementById('calendarDaysGrid');
  if (!daysGrid) return;
  daysGrid.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const tasks = window.CALENDAR_TASKS || [];

  // Helper to test if a task falls on YYYY-MM-DD
  function getTasksForDay(y, m, d) {
    const targetStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return tasks.filter(t => t.due_date && t.due_date.startsWith(targetStr));
  }

  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayNum = prevMonthDays - i;
    const cell = document.createElement('div');
    cell.className = 'p-2 rounded-xl bg-surface-low/30 border border-surface-border/30 text-slate-600 text-xs min-h-[75px]';
    cell.innerHTML = `<span>${dayNum}</span>`;
    daysGrid.appendChild(cell);
  }

  // Current month days
  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div');
    const isToday = (today.getFullYear() === year && today.getMonth() === month && today.getDate() === day);
    
    cell.className = `p-2 rounded-xl border text-xs min-h-[75px] flex flex-col justify-between transition-colors ${
      isToday ? 'bg-primary/10 border-primary/60 text-white' : 'bg-surface-low border-surface-border/60 text-slate-300'
    }`;

    const dayTasks = getTasksForDay(year, month, day);
    let badgesHtml = '';
    
    if (dayTasks.length > 0) {
      badgesHtml = '<div class="space-y-1 mt-1 overflow-hidden">';
      dayTasks.forEach(t => {
        let badgeColor = 'bg-violet-500/20 text-violet-300 border-violet-500/40';
        if (t.category === 'quizzes') badgeColor = 'bg-rose-500/20 text-rose-300 border-rose-500/40';
        if (t.category === 'notes') badgeColor = 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
        if (t.category === 'miscellaneous') badgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/40';

        badgesHtml += `
          <div class="px-1.5 py-0.5 rounded text-[10px] font-mono truncate border ${badgeColor}" title="${t.title}">
            • ${t.subject ? t.subject.slice(0, 7) : t.title.slice(0, 10)}
          </div>
        `;
      });
      badgesHtml += '</div>';
    }

    cell.innerHTML = `
      <div class="flex items-center justify-between">
<span class="font-mono ${isToday ? 'text-primary font-bold' : ''}">${day}</span>
        ${isToday ? '<span class="text-[9px] uppercase font-mono px-1 py-0.2 bg-primary text-white rounded">TODAY</span>' : ''}
      </div>
      ${badgesHtml}
    `;

    daysGrid.appendChild(cell);
  }

  // Next month leading days to complete grid (up to 35 or 42 cells)
  const totalCells = firstDay + daysInMonth;
  const remaining = (totalCells % 7 === 0) ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remaining; i++) {
    const cell = document.createElement('div');
    cell.className = 'p-2 rounded-xl bg-surface-low/30 border border-surface-border/30 text-slate-600 text-xs min-h-[75px]';
    cell.innerHTML = `<span>${i}</span>`;
    daysGrid.appendChild(cell);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderCalendar();

  const prev = document.getElementById('prevMonthBtn');
  const next = document.getElementById('nextMonthBtn');
  if (prev) {
    prev.addEventListener('click', () => {
      currentDate.setMonth(currentDate.getMonth() - 1);
      renderCalendar();
    });
  }
  if (next) {
    next.addEventListener('click', () => {
      currentDate.setMonth(currentDate.getMonth() + 1);
      renderCalendar();
    });
  }
});

// Mark a task done from the timeline panel (dashboard.ejs defines its own copy)
async function markTaskDone(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/complete`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      location.reload();
    } else {
      alert('Could not complete task.');
    }
  } catch (e) {
    alert('Network error marking task done.');
  }
}
