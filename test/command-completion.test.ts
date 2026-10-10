import { test, expect } from 'bun:test';
import { commandCompletion, completeCommand, completionStatus } from '../src/command-completion.js';
import stringWidth from 'string-width';

test('completion narrows commands, then providers, then models one word at a time', () => {
  expect(commandCompletion('/m').suggestions).toEqual(['/metrics', '/model']);
  const command = commandCompletion('/mo');
  expect(command.suggestions).toEqual(['/model']);
  const first = completeCommand('/mo', command)!;
  expect(first).toEqual({ input: '/model ', cursor: 7 });
  expect(commandCompletion(first.input).suggestions).toEqual(['meta', 'openai']);
  const provider = commandCompletion('/model o');
  expect(provider.suggestions).toEqual(['openai']);
  const second = completeCommand('/model o', provider)!;
  expect(second.input).toBe('/model openai ');
  expect(commandCompletion(second.input).suggestions).toEqual(['luna6', 'sol6.1']);
  const model = commandCompletion('/model openai s');
  expect(model.suggestions).toEqual(['sol6.1']);
  const third = completeCommand('/model openai s', model)!;
  expect(third.input).toBe('/model openai sol6.1 ');
  expect(commandCompletion(third.input).suggestions).toEqual([]);
  expect(commandCompletion('/model meta ').suggestions).toEqual(['ms1.3', 'ms1.3c']);
  expect(commandCompletion('/model openai gpt-6.1').suggestions).toEqual(['sol6.1']);
  expect(commandCompletion('/model openai 3').suggestions).toEqual(['luna6']);
});

test('completion replaces the token under the cursor and preserves later arguments', () => {
  const input = '/mo openai luna6';
  const result = completeCommand(input, commandCompletion(input, 3))!;
  expect(result).toEqual({ input: '/model openai luna6', cursor: 7 });
  const middle = '/model opXYZ luna6';
  expect(completeCommand(middle, commandCompletion(middle, 9))!.input).toBe('/model openai luna6');
  expect(completeCommand('/m', commandCompletion('/m'), 1)!.input).toBe('/model ');
  expect(commandCompletion('/model\topenai   l').suggestions).toEqual(['luna6']);
  for (const input of ['hello /m', '/unknown', '/model other ', '/zoom 0 ', '/model openai luna6 extra', '/m\nhello']) {
    expect(commandCompletion(input).suggestions).toEqual([]);
    expect(completeCommand(input, commandCompletion(input))).toBeUndefined();
  }
});

test('suggestion footer keeps the selected option visible within narrow terminal widths', () => {
  const completion = commandCompletion('/');
  for (let index = 0; index < completion.suggestions.length; index++) {
    const footer = completionStatus(completion, index, 40);
    expect(footer).toContain(`[${completion.suggestions[index]}]`);
    expect(footer).toEndWith(' · Tab');
    expect(stringWidth(footer)).toBeLessThanOrEqual(40);
  }
});
