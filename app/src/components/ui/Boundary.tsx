import {Component, type ReactNode} from 'react';
import {ErrorBox} from './Bits';

/** A render error inside a page shows this instead of unmounting the whole site. */
export class Boundary extends Component<{children: ReactNode; resetKey?: string}, {error: Error | null}> {
  state = {error: null as Error | null};
  static getDerivedStateFromError(error: Error) {
    return {error};
  }
  componentDidUpdate(prev: {resetKey?: string}) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({error: null});
  }
  componentDidCatch(error: Error) {
    console.error('[square] page crashed', error);
  }
  render() {
    if (this.state.error) {
      return (
        <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <ErrorBox title="This page hit a bug" body={this.state.error.message} retry={() => this.setState({error: null})} />
        </main>
      );
    }
    return this.props.children;
  }
}
