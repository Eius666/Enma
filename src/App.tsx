import React, { useState, useEffect } from 'react';
import { format, addMonths, subMonths, startOfMonth, endOfMonth, 
         startOfWeek, endOfWeek, isSameMonth, isSameDay, addDays, parseISO } from 'date-fns';
import { FaCalendarAlt, FaStickyNote, FaWallet, FaPlus, FaTrash, 
         FaChevronLeft, FaChevronRight, FaCircle } from 'react-icons/fa';
import './App.css';

// Типы данных
type Task = {
  id: string;
  text: string;
  date: Date;
  color: string;
};

type Note = {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
};

type Transaction = {
  id: string;
  amount: number;
  description: string;
  type: 'income' | 'expense';
  category: string;
  date: Date;
};

// Контекст для темы
interface ThemeContextType {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

const ThemeContext = React.createContext<ThemeContextType>({
  theme: 'light',
  toggleTheme: () => {}
});

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'calendar' | 'notes' | 'finance'>('calendar');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Функция переключения темы
  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  // Устанавливаем тему при загрузке
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <div className="app" data-theme={theme}>
        <header className="app-header">
          <h1>My Personal Organizer</h1>
          <button 
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </header>

        <nav className="tabs">
          <button 
            onClick={() => setActiveTab('calendar')}
            className={activeTab === 'calendar' ? 'active' : ''}
          >
            Calendar
          </button>
          <button
            onClick={() => setActiveTab('notes')}
            className={activeTab === 'notes' ? 'active' : ''}
          >
            Notes
          </button>
          <button
            onClick={() => setActiveTab('finance')}
            className={activeTab === 'finance' ? 'active' : ''}
          >
            Finance
          </button>
        </nav>

        <main className="content">
          {activeTab === 'calendar' && <CalendarTaskManager />}
          {activeTab === 'notes' && <NotesManager />}
          {activeTab === 'finance' && <FinanceManager />}
        </main>
      </div>
    </ThemeContext.Provider>
  );
};

// ====================== КАЛЕНДАРЬ ======================
const CalendarTaskManager: React.FC = () => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTask, setNewTask] = useState('');
  const [selectedColor, setSelectedColor] = useState('#4285F4');

  const colors = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9B72CB'];

  useEffect(() => {
    const savedTasks = localStorage.getItem('calendarTasks');
    if (savedTasks) {
      try {
        const parsed = JSON.parse(savedTasks);
        const tasksWithDates = parsed.map((task: any) => ({
          ...task,
          date: parseISO(task.date)
        }));
        setTasks(tasksWithDates);
      } catch (e) {
        console.error("Failed to parse tasks", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('calendarTasks', JSON.stringify(tasks));
  }, [tasks]);

  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const goToToday = () => {
    const today = new Date();
    setCurrentDate(today);
    setSelectedDate(today);
  };

  const addTask = () => {
    if (newTask.trim()) {
      const newTaskObj: Task = {
        id: Date.now().toString(),
        text: newTask,
        date: selectedDate,
        color: selectedColor
      };
      
      setTasks([...tasks, newTaskObj]);
      setNewTask('');
    }
  };

  const deleteTask = (id: string) => {
    setTasks(tasks.filter(task => task.id !== id));
  };

  const renderHeader = () => (
    <div className="calendar-header">
      <button onClick={goToToday} className="today-btn">
        Today
      </button>
      <div className="month-navigation">
        <button onClick={prevMonth} className="nav-btn">
          <FaChevronLeft />
        </button>
        <h2>{format(currentDate, 'MMMM yyyy')}</h2>
        <button onClick={nextMonth} className="nav-btn">
          <FaChevronRight />
        </button>
      </div>
      <div className="color-picker">
        {colors.map(color => (
          <button 
            key={color}
            className={`color-btn ${selectedColor === color ? 'selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => setSelectedColor(color)}
          />
        ))}
      </div>
    </div>
  );

  const renderDaysOfWeek = () => {
    const days = [];
    const startDate = startOfWeek(currentDate);
    
    for (let i = 0; i < 7; i++) {
      const day = addDays(startDate, i);
      days.push(
        <div className="day-name" key={i}>
          {format(day, 'EEE')}
        </div>
      );
    }
    
    return <div className="days-row">{days}</div>;
  };

  const renderCalendarCells = () => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const rows = [];
    let days = [];
    let day = startDate;
    
    while (day <= endDate) {
      for (let i = 0; i < 7; i++) {
        const cloneDay = day;
        const dayTasks = tasks.filter(task => isSameDay(task.date, cloneDay));
        const isCurrentMonth = isSameMonth(day, monthStart);
        const isToday = isSameDay(day, new Date());
        const isSelected = isSameDay(day, selectedDate);
        
        days.push(
          <div
            className={`day-cell 
              ${!isCurrentMonth ? 'disabled' : ''} 
              ${isToday ? 'today' : ''}
              ${isSelected ? 'selected' : ''}`}
            key={day.toString()}
            onClick={() => {
              if (isCurrentMonth) setSelectedDate(cloneDay);
            }}
          >
            <div className="day-number">{format(day, 'd')}</div>
            <div className="day-tasks">
              {dayTasks.slice(0, 3).map(task => (
                <div 
                  key={task.id} 
                  className="task-badge"
                  style={{ backgroundColor: task.color }}
                >
                  {task.text}
                </div>
              ))}
              {dayTasks.length > 3 && (
                <div className="more-tasks">+{dayTasks.length - 3} more</div>
              )}
            </div>
          </div>
        );
        day = addDays(day, 1);
      }
      
      rows.push(
        <div className="week-row" key={day.toString()}>
          {days}
        </div>
      );
      days = [];
    }
    
    return <div className="calendar-body">{rows}</div>;
  };

  const renderSelectedDayPanel = () => {
    const dayTasks = tasks.filter(task => isSameDay(task.date, selectedDate));
    
    return (
      <div className="selected-day-panel">
        <h3>{format(selectedDate, 'EEEE, MMMM d, yyyy')}</h3>
        
        <div className="task-input-container">
          <input
            type="text"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="Add new task"
            onKeyPress={(e) => e.key === 'Enter' && addTask()}
          />
          <button onClick={addTask} className="add-task-btn">
            <FaPlus />
          </button>
        </div>
        
        <div className="task-list">
          {dayTasks.length === 0 ? (
            <p className="no-tasks">No tasks for this day</p>
          ) : (
            dayTasks.map(task => (
              <div key={task.id} className="task-item">
                <FaCircle 
                  className="task-icon" 
                  style={{ color: task.color }} 
                />
                <span className="task-text">{task.text}</span>
                <button 
                  onClick={() => deleteTask(task.id)} 
                  className="delete-btn"
                >
                  <FaTrash />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="calendar-container">
      {renderHeader()}
      {renderDaysOfWeek()}
      {renderCalendarCells()}
      {renderSelectedDayPanel()}
    </div>
  );
};

// ====================== ЗАМЕТКИ ======================
const NotesManager: React.FC = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);

  useEffect(() => {
    const savedNotes = localStorage.getItem('notes');
    if (savedNotes) {
      try {
        const parsed = JSON.parse(savedNotes);
        const notesWithDates = parsed.map((note: any) => ({
          ...note,
          createdAt: parseISO(note.createdAt)
        }));
        setNotes(notesWithDates);
        if (parsed.length > 0) {
          setActiveNoteId(parsed[0].id);
          setTitle(parsed[0].title);
          setContent(parsed[0].content);
        }
      } catch (e) {
        console.error("Failed to parse notes", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('notes', JSON.stringify(notes));
  }, [notes]);

  const createNewNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: 'New Note',
      content: '',
      createdAt: new Date()
    };
    
    setNotes([...notes, newNote]);
    setActiveNoteId(newNote.id);
    setTitle(newNote.title);
    setContent(newNote.content);
    setIsEditingTitle(true);
  };

  const saveNote = () => {
    if (!activeNoteId) return;
    
    setNotes(notes.map(note => 
      note.id === activeNoteId 
        ? { ...note, title, content } 
        : note
    ));
  };

  const selectNote = (id: string) => {
    const note = notes.find(note => note.id === id);
    if (note) {
      setActiveNoteId(id);
      setTitle(note.title);
      setContent(note.content);
      setIsEditingTitle(false);
    }
  };

  const deleteNote = (id: string) => {
    const newNotes = notes.filter(note => note.id !== id);
    setNotes(newNotes);
    
    if (activeNoteId === id) {
      if (newNotes.length > 0) {
        selectNote(newNotes[0].id);
      } else {
        setActiveNoteId(null);
        setTitle('');
        setContent('');
      }
    }
  };

  const formatDate = (date: Date) => {
    return format(date, 'MMM d, yyyy h:mm a');
  };

  return (
    <div className="notes-container">
      <div className="notes-sidebar">
        <button className="new-note-btn" onClick={createNewNote}>
          <FaPlus /> New Note
        </button>
        
        <div className="notes-list">
          {notes.map(note => (
            <div 
              key={note.id}
              className={`note-item ${activeNoteId === note.id ? 'active' : ''}`}
              onClick={() => selectNote(note.id)}
            >
              <div className="note-title">{note.title}</div>
              <div className="note-date">{formatDate(note.createdAt)}</div>
              <button 
                className="delete-note-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteNote(note.id);
                }}
              >
                <FaTrash />
              </button>
            </div>
          ))}
        </div>
      </div>
      
      <div className="note-editor">
        {activeNoteId ? (
          <>
            {isEditingTitle ? (
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  setIsEditingTitle(false);
                  saveNote();
                }}
                onKeyPress={(e) => e.key === 'Enter' && setIsEditingTitle(false)}
                autoFocus
                className="title-input"
              />
            ) : (
              <h2 onClick={() => setIsEditingTitle(true)}>
                {title || 'Untitled Note'}
              </h2>
            )}
            
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onBlur={saveNote}
              placeholder="Start writing your note here..."
              className="note-content"
            />
          </>
        ) : (
          <div className="empty-state">
            <h2>No Notes</h2>
            <p>Create a new note to get started</p>
            <button onClick={createNewNote} className="cta-button">
              Create First Note
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ====================== ФИНАНСЫ ======================
const FinanceManager: React.FC = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [newTransaction, setNewTransaction] = useState({
    amount: '',
    description: '',
    type: 'expense' as 'income' | 'expense',
    category: 'food',
  });
  const [balance, setBalance] = useState(0);
  const [income, setIncome] = useState(0);
  const [expenses, setExpenses] = useState(0);

  const categories = {
    income: ['Salary', 'Freelance', 'Investment', 'Gift'],
    expense: ['Food', 'Transport', 'Housing', 'Entertainment', 'Shopping']
  };

  useEffect(() => {
    const savedTransactions = localStorage.getItem('transactions');
    if (savedTransactions) {
      try {
        const parsed = JSON.parse(savedTransactions);
        const transactionsWithDates = parsed.map((t: any) => ({
          ...t,
          date: parseISO(t.date)
        }));
        setTransactions(transactionsWithDates);
      } catch (e) {
        console.error("Failed to parse transactions", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('transactions', JSON.stringify(transactions));
    
    const newIncome = transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
      
    const newExpenses = transactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
      
    setIncome(newIncome);
    setExpenses(newExpenses);
    setBalance(newIncome - newExpenses);
  }, [transactions]);

  const addTransaction = () => {
    if (!newTransaction.amount || !newTransaction.description) return;
    
    const newTransactionObj: Transaction = {
      id: Date.now().toString(),
      amount: parseFloat(newTransaction.amount),
      description: newTransaction.description,
      type: newTransaction.type,
      category: newTransaction.category,
      date: new Date()
    };
    
    setTransactions([...transactions, newTransactionObj]);
    
    setNewTransaction({
      amount: '',
      description: '',
      type: 'expense',
      category: 'food'
    });
  };

  const deleteTransaction = (id: string) => {
    setTransactions(transactions.filter(t => t.id !== id));
  };

  const formatAmount = (amount: number) => {
    return amount.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });
  };

  return (
    <div className="finance-container">
      <div className="finance-summary">
        <div className="balance-card">
          <h3>Current Balance</h3>
          <div className={`balance-amount ${balance >= 0 ? 'positive' : 'negative'}`}>
            {formatAmount(balance)}
          </div>
        </div>
        
        <div className="income-card">
          <h3>Income</h3>
          <div className="amount positive">{formatAmount(income)}</div>
        </div>
        
        <div className="expenses-card">
          <h3>Expenses</h3>
          <div className="amount negative">{formatAmount(expenses)}</div>
        </div>
      </div>
      
      <div className="transaction-form">
        <h3>Add New Transaction</h3>
        
        <div className="form-group">
          <label>Type</label>
          <div className="type-selector">
            <button
              className={`type-btn ${newTransaction.type === 'income' ? 'active' : ''}`}
              onClick={() => setNewTransaction({...newTransaction, type: 'income'})}
            >
              Income
            </button>
            <button
              className={`type-btn ${newTransaction.type === 'expense' ? 'active' : ''}`}
              onClick={() => setNewTransaction({...newTransaction, type: 'expense'})}
            >
              Expense
            </button>
          </div>
        </div>
        
        <div className="form-group">
          <label>Category</label>
          <select
            value={newTransaction.category}
            onChange={(e) => setNewTransaction({...newTransaction, category: e.target.value})}
          >
            {(newTransaction.type === 'income' 
              ? categories.income 
              : categories.expense).map(cat => (
              <option key={cat} value={cat.toLowerCase()}>
                {cat}
              </option>
            ))}
          </select>
        </div>
        
        <div className="form-group">
          <label>Amount</label>
          <input
            type="number"
            placeholder="0.00"
            value={newTransaction.amount}
            onChange={(e) => setNewTransaction({...newTransaction, amount: e.target.value})}
          />
        </div>
        
        <div className="form-group">
          <label>Description</label>
          <input
            type="text"
            placeholder="What's this for?"
            value={newTransaction.description}
            onChange={(e) => setNewTransaction({...newTransaction, description: e.target.value})}
          />
        </div>
        
        <button 
          onClick={addTransaction}
          className="add-transaction-btn"
        >
          Add Transaction
        </button>
      </div>
      
      <div className="transaction-history">
        <h3>Recent Transactions</h3>
        
        {transactions.length === 0 ? (
          <p className="no-transactions">No transactions yet</p>
        ) : (
          <div className="transactions-list">
            {[...transactions]
              .sort((a, b) => b.date.getTime() - a.date.getTime())
              .map(transaction => (
                <div key={transaction.id} className={`transaction ${transaction.type}`}>
                  <div className="transaction-info">
                    <div className="transaction-category">
                      {transaction.category}
                    </div>
                    <div className="transaction-description">
                      {transaction.description}
                    </div>
                    <div className="transaction-date">
                      {format(transaction.date, 'MMM d, h:mm a')}
                    </div>
                  </div>
                  
                  <div className="transaction-amount">
                    <span className={transaction.type}>
                      {transaction.type === 'income' ? '+' : '-'}
                      {formatAmount(transaction.amount)}
                    </span>
                    <button 
                      onClick={() => deleteTransaction(transaction.id)}
                      className="delete-transaction"
                    >
                      <FaTrash />
                    </button>
                  </div>
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
