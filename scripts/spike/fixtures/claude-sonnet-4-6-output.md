# Graph Theory — Eulerian & Hamiltonian Paths

## Eulerian Circuits

> [!definition] Eulerian Circuit
> A **closed walk** in graph $G = (V, E)$ that uses every edge in $E$ exactly once.
> Also called an *Euler tour*. A graph that admits one is *Eulerian*.

> [!theorem] Euler's Theorem
> A connected graph $G$ has an Eulerian circuit if and only if every vertex has even degree.

> [!proof]
> $(\Rightarrow)$ Let $C$ be an Eulerian circuit of $G$. Each time $C$ visits vertex $v$,
> it arrives via one edge and leaves via another distinct edge, adding $2$ to $\deg(v)$.
> Thus every vertex has even degree.
>
> $(\Leftarrow)$ Assume all degrees are even. Begin at any vertex and greedily follow
> unused edges until returning to the start (this must happen since degrees are even).
> If edges remain, the connected subgraph of unused edges also has all-even degrees.
> Find a new circuit there sharing a vertex with the first, splice them together, and
> repeat. By induction on $|E|$ the algorithm terminates with a full Eulerian circuit.

$$
G \text{ is Eulerian} \iff \deg(v) \equiv 0 \pmod{2} \quad \forall v \in V(G)
$$

## Example — $C_4$ with Diagonal

> [!diagram] $C_4$ with one diagonal
> ![fig](./assets/<asset-placeholder>.png)
> ```json
> {
>   "type": "undirected",
>   "vertices": ["a", "b", "c", "d"],
>   "edges": [["a","b"],["b","c"],["c","d"],["d","a"],["a","c"]],
>   "caption": "C4 with one diagonal"
> }
> ```
>
> Degree sequence: $\deg(a) = 3,\; \deg(b) = 2,\; \deg(c) = 3,\; \deg(d) = 2$.
> Since vertices $a$ and $c$ have odd degree the graph is **not** Eulerian,
> but it does have an Eulerian path from $a$ to $c$.

## Eulerian Path

> [!definition] Eulerian Path
> A walk traversing every edge exactly once, not required to be closed.

> [!theorem] Eulerian Path Condition
> A connected graph has an Eulerian path iff it has exactly two odd-degree vertices.
> The path must start at one and end at the other.

## Hamiltonian Paths

> [!definition] Hamiltonian Path
> A path that visits every **vertex** of $G$ exactly once.
> A closed version is a *Hamiltonian circuit*. Unlike Eulerian circuits,
> no efficient characterisation is known — the decision problem is NP-complete.

<!-- confidence: high -->
