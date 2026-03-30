import React from 'react';

type IconName =
  | 'gear'
  | 'sun'
  | 'moon'
  | 'close'
  | 'expand'
  | 'hamburger'
  | 'x-mark'
  | 'pencil'
  | 'refresh'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'triangle-left'
  | 'triangle-right'
  | 'compass'
  | 'book'
  | 'users'
  | 'branch'
  | 'chat'
  | 'arrow-left';

interface IconProps {
  name: IconName;
  className?: string;
  size?: string;
}

const paths: Record<IconName, React.ReactNode> = {
  gear: (
    <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.86z" fillRule="evenodd" />
  ),
  sun: (
    <path d="M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM8 1.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0V2a.5.5 0 0 1 .5-.5zm0 11a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1a.5.5 0 0 1 .5-.5zM1.5 8a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1H2a.5.5 0 0 1-.5-.5zm11 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5zM3.4 3.4a.5.5 0 0 1 .7 0l.7.7a.5.5 0 1 1-.7.7l-.7-.7a.5.5 0 0 1 0-.7zm8.5 8.5a.5.5 0 0 1 .7 0l.7.7a.5.5 0 1 1-.7.7l-.7-.7a.5.5 0 0 1 0-.7zM3.4 12.6a.5.5 0 0 1 0-.7l.7-.7a.5.5 0 1 1 .7.7l-.7.7a.5.5 0 0 1-.7 0zm8.5-8.5a.5.5 0 0 1 0-.7l.7-.7a.5.5 0 1 1 .7.7l-.7.7a.5.5 0 0 1-.7 0z" />
  ),
  moon: (
    <path d="M6 2a6 6 0 1 0 6.5 9.5A5 5 0 0 1 6 2z" />
  ),
  close: (
    <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  ),
  expand: (
    <path d="M2 2h4M2 2v4M14 14h-4M14 14v-4M14 2h-4M14 2v4M2 14h4M2 14v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  ),
  hamburger: (
    <>
      <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="12" x2="14" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  'x-mark': (
    <path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  ),
  pencil: (
    <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.2" fill="none" />
  ),
  refresh: (
    <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-right': (
    <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-left': (
    <path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-down': (
    <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'triangle-left': (
    <path d="M11 3L5 8l6 5V3z" />
  ),
  'triangle-right': (
    <path d="M5 3l6 5-6 5V3z" />
  ),
  compass: (
    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2zM6.2 6.2l5.3-1.7-1.7 5.3-5.3 1.7 1.7-5.3zm1.8.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" fillRule="evenodd" />
  ),
  book: (
    <path d="M2 2.5A.5.5 0 0 1 2.5 2h3.05a2.5 2.5 0 0 1 2.15 1.23L8 3.8l.3-.57A2.5 2.5 0 0 1 10.45 2h3.05a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5h-3.5a1.5 1.5 0 0 0-1.3.75.5.5 0 0 1-.86.01l-.01-.01A1.5 1.5 0 0 0 6.5 13H3a.5.5 0 0 1-.5-.5v-10zm5.5 2.1A1.5 1.5 0 0 0 6.05 3H3v9h3.5a2.5 2.5 0 0 1 1 .2V4.6zm1 0V12.2a2.5 2.5 0 0 1 1-.2H13V3h-3.05A1.5 1.5 0 0 0 8.5 4.6z" fillRule="evenodd" />
  ),
  users: (
    <path d="M6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM4 8c-1.7 0-3 .8-3 2.5V12h6v-1.5C7 8.8 5.7 8 4 8zm8 0c-1.7 0-3 .8-3 2.5V12h6v-1.5C15 8.8 13.7 8 12 8z" />
  ),
  branch: (
    <path d="M4 2a2 2 0 0 0-1 3.73V10.27A2 2 0 1 0 5 10.27V8.5c.6.3 1.3.5 2 .5h2a2 2 0 0 0 2-2v-.77A2 2 0 1 0 9 5.73V7a1 1 0 0 1-1 1H7a4 4 0 0 1-2-.54V5.73A2 2 0 0 0 4 2zm0 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM4 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fillRule="evenodd" />
  ),
  chat: (
    <path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12H4v2.5L8 12h5.5A1.5 1.5 0 0 0 15 10.5v-7A1.5 1.5 0 0 0 13.5 2h-11zM4.5 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3.5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3.5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fillRule="evenodd" />
  ),
  'arrow-left': (
    <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
};

export default function Icon({ name, className, size = '1em' }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
