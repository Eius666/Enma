import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthScreen } from '../workspaces/AuthScreen';

// E-mail sign-in and registration on the manual sign-in screen. Firebase Auth
// is a fake that records calls; nothing leaves the process.

const mockCalls: { signIn: unknown[][]; signUp: unknown[][] } = { signIn: [], signUp: [] };
const mockBehaviour: { signIn: () => Promise<unknown>; signUp: () => Promise<unknown> } = {
  signIn: async () => ({ user: { uid: 'u-1' } }),
  signUp: async () => ({ user: { uid: 'u-new' } }),
};

jest.mock('../../firebase', () => ({ auth: { __auth: true } }));
jest.mock('../../config/env', () => ({ env: { botUsername: 'TestBot' } }));
jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => { mockCalls.signIn.push(args); return mockBehaviour.signIn(); },
  createUserWithEmailAndPassword: (...args: unknown[]) => { mockCalls.signUp.push(args); return mockBehaviour.signUp(); },
}));

beforeEach(() => {
  mockCalls.signIn = [];
  mockCalls.signUp = [];
  mockBehaviour.signIn = async () => ({ user: { uid: 'u-1' } });
  mockBehaviour.signUp = async () => ({ user: { uid: 'u-new' } });
  localStorage.clear();
});

const renderScreen = (props: Partial<React.ComponentProps<typeof AuthScreen>> = {}) =>
  render(<AuthScreen theme="dark" onToggleTheme={() => undefined} language="en" {...props} />);
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const agree = () => fireEvent.click(screen.getByRole('checkbox'));

test('signing in needs the terms consent first, then calls Firebase with the entered credentials', async () => {
  renderScreen();
  const submit = screen.getByRole('button', { name: 'Sign in' });
  expect(submit).toBeDisabled();
  agree();
  expect(submit).toBeEnabled();
  expect(localStorage.getItem('enma.agreedToTerms')).toBe('true');
  fill('Email', 'maria@example.com');
  fill('Password', 'secret123');
  fireEvent.click(submit);
  await waitFor(() => expect(mockCalls.signIn).toHaveLength(1));
  expect(mockCalls.signIn[0]).toEqual([{ __auth: true }, 'maria@example.com', 'secret123']);
  expect(mockCalls.signUp).toHaveLength(0);
  await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
});

test('a remembered consent is not asked again', () => {
  localStorage.setItem('enma.agreedToTerms', 'true');
  renderScreen();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('a failed sign-in shows the error and keeps the entered e-mail', async () => {
  mockBehaviour.signIn = async () => { throw new Error('Firebase: Error (auth/invalid-credential).'); };
  localStorage.setItem('enma.agreedToTerms', 'true');
  renderScreen();
  fill('Email', 'maria@example.com');
  fill('Password', 'wrong-pass');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Firebase: Error (auth/invalid-credential).')).toBeTruthy();
  expect(screen.getByLabelText('Email')).toHaveValue('maria@example.com');
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('registration creates the account and stores the display name locally for the new uid', async () => {
  localStorage.setItem('enma.agreedToTerms', 'true');
  renderScreen();
  fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
  fill('Name', '  Maria  ');
  fill('Email', 'new@example.com');
  fill('Password', 'secret123');
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(mockCalls.signUp).toHaveLength(1));
  expect(mockCalls.signUp[0]).toEqual([{ __auth: true }, 'new@example.com', 'secret123']);
  expect(mockCalls.signIn).toHaveLength(0);
  await waitFor(() => expect(JSON.parse(localStorage.getItem('enma.u-new.profile') ?? 'null')).toEqual({ displayName: 'Maria' }));
});

test('registration without a name is refused before Firebase is called', async () => {
  localStorage.setItem('enma.agreedToTerms', 'true');
  renderScreen();
  fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
  fill('Name', '   ');
  fill('Email', 'new@example.com');
  fill('Password', 'secret123');
  fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByText('Please share your name so we can greet you.')).toBeTruthy();
  expect(mockCalls.signUp).toHaveLength(0);
});

test('inside Telegram the registration form starts with the Telegram name', () => {
  localStorage.setItem('enma.agreedToTerms', 'true');
  renderScreen({ initialName: 'Ann Lee' });
  fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
  expect(screen.getByLabelText('Name')).toHaveValue('Ann Lee');
});
