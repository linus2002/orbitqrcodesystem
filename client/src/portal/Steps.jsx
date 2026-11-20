/**
 * Where the person is in the check: Your details -> Check the pack -> Answer.
 *
 * Law of connectedness: three loose circles read as three separate things;
 * joined by one line they read as one journey, with an end in sight. That
 * matters most to someone met with a form before they can check anything -
 * the line shows the form is step one of three, not the whole job.
 *
 * Shown only while there is a details step; a page that asks for nothing
 * has no journey to show.
 */
import { Icon } from '../components/Icons.jsx';

const STEPS = ['Your details', 'Check the pack', 'Your answer'];

/** @param {{ current: 0 | 1 | 2 }} props  the step being done now */
export default function Steps({ current }) {
  return (
    <ol className="steps" aria-label="Steps">
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'next';
        return (
          <li key={label} className={`step step-${state}`} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true">
              {state === 'done' ? <Icon name="tick" /> : i + 1}
            </span>
            <span className="step-label">
              {label}
              {state === 'done' && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
