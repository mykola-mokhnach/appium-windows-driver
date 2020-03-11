import recordScreenCmds from './record-screen';

const commands = {};
Object.assign(
  commands,
  recordScreenCmds,
  // add other command types here
);

export { commands };
export default commands;
