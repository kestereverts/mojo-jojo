// Fixture: a default-exported factory whose own body throws (a real module bug).
export default () => {
  throw new Error("factory kaboom");
};
